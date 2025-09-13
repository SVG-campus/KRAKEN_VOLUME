// src/index.js  (CommonJS for PM2)
require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const axios = require('axios');

// ================== ENV / CONFIG ==================
const PORT                        = Number(process.env.PORT || 3000);
const RANK_MODE                   = (process.env.RANK_MODE || 'ratio');   // 'ratio' | 'volvel'
const RATE_WINDOW_SEC             = Number(process.env.RATE_WINDOW_SEC || 60);

const ALERT_DIFF_THRESHOLD_PCT    = Number(process.env.ALERT_DIFF_THRESHOLD_PCT || 5);  // default 5%
const ALERT_LEVEL_STEP_PCT        = Number(process.env.ALERT_LEVEL_STEP_PCT || 5);      // 5% buckets: 5,10,15,20...
const ALERT_MIN_INTERVAL_SEC      = Number(process.env.ALERT_MIN_INTERVAL_SEC || 300);  // per-coin cool-down

const SLACK_WEBHOOK_URL           = process.env.SLACK_WEBHOOK_URL || '';
const PAPER                       = `${process.env.PAPER || 'true'}`.toLowerCase() !== 'false';

// Pair selection:
// - If KRAKEN_WS_PAIRS is "ALL", we auto-discover pairs from Kraken REST.
// - Otherwise, we use the provided comma-list.
const KRAKEN_WS_PAIRS_RAW         = process.env.KRAKEN_WS_PAIRS || 'SOL/USD,XBT/USD,ETH/USD,SUI/USD';
const KRAKEN_QUOTE                = process.env.KRAKEN_QUOTE || 'USD';               // used when auto-discovering
const MAX_SUBSCRIBE_PAIRS         = Number(process.env.MAX_SUBSCRIBE_PAIRS || 300);  // safety limit
const SUB_BATCH_SIZE              = Number(process.env.SUB_BATCH_SIZE || 25);
const SUB_BATCH_DELAY_MS          = Number(process.env.SUB_BATCH_DELAY_MS || 600);
const EXCLUDE_REGEX_STR           = process.env.KRAKEN_EXCLUDE_REGEX || '';          // e.g. '(USDT|EUR)'
const EXCLUDE_REGEX               = EXCLUDE_REGEX_STR ? new RegExp(EXCLUDE_REGEX_STR) : null;

// ================== EXPRESS + SOCKET.IO ==================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const frontendDistPath = path.join(__dirname, 'dist');
app.use(express.static(frontendDistPath));

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

let WS_PAIRS = [];        // will be set below (env or discovery)
let discoveredInfo = { total: 0, using: 0, quote: KRAKEN_QUOTE };

app.get('/api/pairs', (_req, res) => {
  res.json({ mode: (KRAKEN_WS_PAIRS_RAW.trim().toUpperCase() === 'ALL' ? 'auto' : 'env'),
             quote: KRAKEN_QUOTE, totalDiscovered: discoveredInfo.total, subscribed: discoveredInfo.using,
             pairs: WS_PAIRS });
});

function pct(n){ return Number.isFinite(n) ? Math.round(n*100)/100 : 0; }
function momentumScore(s) {
  // ratio of velocity to absolute price change; avoid /0
  const denom = Math.max(0.0001, Math.abs(Number(s.priceChangePct || 0)));
  return Number(s.volVelPct || 0) / denom;
}

const perPair = Object.create(null);

function currentSnapshot() {
  const pairs = {};
  for (const p of WS_PAIRS) {
    const S = perPair[p];
    if (!S || !S.last) continue;
    pairs[p] = {
      ts: S.last.ts,
      price: S.last.price,
      avg24: S.last.avg24,
      vol24: S.last.vol24,
      volVelPct: pct(S.volVelPct),
      priceChangePct: pct(S.priceChangePct),
      diffPct: pct(S.diffPct),
      ratio: Number((momentumScore({
        volVelPct: pct(S.volVelPct),
        priceChangePct: pct(S.priceChangePct)
      })).toFixed(2))
    };
  }

  const ranked = Object.entries(pairs)
    .sort((a, b) => {
      const av = a[1], bv = b[1];
      const as = (RANK_MODE === 'ratio') ? momentumScore(av) : av.volVelPct;
      const bs = (RANK_MODE === 'ratio') ? momentumScore(bv) : bv.volVelPct;
      return bs - as;
    })
    .map(([k]) => k);

  return {
    ts: Math.floor(Date.now()/1000),
    meta: { rankMode: RANK_MODE, quote: KRAKEN_QUOTE, subscribed: WS_PAIRS.length },
    pairs,
    top: ranked.slice(0, 5)
  };
}

app.get('/api/snapshot', (_req, res) => res.json(currentSnapshot()));

app.use((_req, res) => {
  res.sendFile(path.join(frontendDistPath, 'index.html'));
});

io.on('connection', (socket) => {
  socket.emit('hello', { ok: true, ts: Date.now() });
});

// ================== SLACK ==================
async function slack(text, blocks) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await axios.post(SLACK_WEBHOOK_URL, blocks ? { text, blocks } : { text });
  } catch (e) {
    console.error('Slack error', e.message);
  }
}

// ================== STATE & COMPUTATION ==================
for (const p of (KRAKEN_WS_PAIRS_RAW.trim().toUpperCase() === 'ALL' ? [] :
                 KRAKEN_WS_PAIRS_RAW.split(',').map(s => s.trim()).filter(Boolean))) {
  perPair[p] = { last: null, buf: [], volVelPct: 0, priceChangePct: 0, diffPct: 0, alert: {} };
}

function computeVelocity(pair, ts, vol24, price, avg24) {
  if (!perPair[pair]) perPair[pair] = { last: null, buf: [], volVelPct: 0, priceChangePct: 0, diffPct: 0, alert: {} };
  const S = perPair[pair];

  const HORIZON_SEC = Math.max(RATE_WINDOW_SEC * 6, 300);
  S.buf.push({ ts, vol24, diff: S.diffPct || 0 });
  while (S.buf.length && ts - S.buf[0].ts > HORIZON_SEC) S.buf.shift();

  let older = S.buf[0];
  for (let i = S.buf.length - 1; i >= 0; i--) {
    if (ts - S.buf[i].ts >= RATE_WINDOW_SEC) { older = S.buf[i]; break; }
  }

  const dt = Math.max(1, ts - older.ts);
  const v0 = Math.max(older.vol24 || 0, 1e-9);
  const dv = vol24 - (older.vol24 || 0);

  const volVelPct = ((dv / v0) * (3600 / dt)) * 100;
  const priceChangePct = ((price - avg24) / Math.max(avg24, 1e-9)) * 100;

  S.last = { ts, vol24, price, avg24 };
  S.volVelPct = volVelPct;
  S.priceChangePct = priceChangePct;
  S.diffPct = volVelPct - priceChangePct;

  maybeAlert(pair, ts);
}

// ================== ALERTING W/ ESCALATION ==================
function nowMs() { return Date.now(); }

function levelForDiff(diff) {
  // 0 if below threshold. Otherwise 1 for >=T, 2 for >=T+step, etc.
  if (diff < ALERT_DIFF_THRESHOLD_PCT) return 0;
  return 1 + Math.floor((diff - ALERT_DIFF_THRESHOLD_PCT) / ALERT_LEVEL_STEP_PCT);
}

function recentSlope(S) {
  // estimate d(diff)/dt over the last few samples
  const n = S.buf.length;
  if (n < 2) return 0;
  const a = S.buf[Math.max(0, n - 3)];
  const b = S.buf[n - 1];
  const d = (b.diff - (a.diff ?? 0));
  const dt = Math.max(1, b.ts - a.ts);
  return d / dt; // % per second
}

function emojiForLevel(lvl) {
  // escalate the hype 😅
  if (lvl >= 5) return '🚀🚀🔥🔥';
  if (lvl === 4) return '🚀🚀🔥';
  if (lvl === 3) return '🚀🔥';
  if (lvl === 2) return '🚀';
  return '⚡';
}

function maybeAlert(pair, tsSec) {
  const S = perPair[pair];
  if (!S || !S.last) return;

  const diff = pct(S.diffPct);
  const lvl = levelForDiff(diff);
  const a = (S.alert ||= { lastTime: 0, lastLevel: 0, lastDiff: 0 });
  const now = nowMs();

  // Only alert if:
  //  - level increased, OR
  //  - enough time has passed and diff is still above threshold (repeat reminder)
  const enoughTime = (now - a.lastTime) >= ALERT_MIN_INTERVAL_SEC * 1000;
  if (lvl === 0) return; // below threshold

  if (lvl > a.lastLevel || enoughTime) {
    const slope = recentSlope(S); // % per second
    const perMin = pct(slope * 60);

    const msg = `${emojiForLevel(lvl)} *${pair}*  diff=${pct(diff)}%  (volVel=${pct(S.volVelPct)}%/h, priceΔ=${pct(S.priceChangePct)}%)  • rising ~${perMin}%/min`;
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: msg } },
      { type: 'context', elements: [
        { type: 'mrkdwn', text: `Level ${lvl} (threshold ${ALERT_DIFF_THRESHOLD_PCT}% step ${ALERT_LEVEL_STEP_PCT}%)` },
        { type: 'mrkdwn', text: `price=${S.last.price.toFixed(6)} avg24=${S.last.avg24.toFixed(6)} vol24=${Math.round(S.last.vol24)}` }
      ]}
    ];
    slack(msg.replace(/\*/g,''), blocks);
    a.lastTime = now;
    a.lastLevel = lvl;
    a.lastDiff = diff;
  }
}

// Broadcast snapshots to UI every 2s
setInterval(() => { io.emit('snapshot', currentSnapshot()); }, 2000);

// ================== KRAKEN WS ==================
function krakenSubscribe(ws, pairs) {
  ws.send(JSON.stringify({ event: 'subscribe', pair: pairs, subscription: { name: 'ticker' } }));
}

async function subscribeInBatches(ws, pairs) {
  const chunks = [];
  for (let i = 0; i < pairs.length; i += SUB_BATCH_SIZE) {
    chunks.push(pairs.slice(i, i + SUB_BATCH_SIZE));
  }
  for (const c of chunks) {
    krakenSubscribe(ws, c);
    await new Promise(r => setTimeout(r, SUB_BATCH_DELAY_MS));
  }
}

function parseTickerMessage(msg) {
  if (!Array.isArray(msg) || msg.length < 2 || typeof msg[1] !== 'object') return null;
  const data = msg[1];
  const maybe2 = typeof msg[2] === 'string' ? msg[2] : '';
  const maybe3 = typeof msg[3] === 'string' ? msg[3] : '';
  const pair = (maybe2.includes('/') ? maybe2 : (maybe3.includes('/') ? maybe3 : null));
  if (!pair) return null;
  const lastPrice = parseFloat(data.c?.[0] || '0');
  const vol24 = parseFloat(data.v?.[1] || '0');
  const avg24 = parseFloat(data.p?.[1] || '0');
  return { pair, lastPrice, vol24, avg24 };
}

function startKraken(pairsToUse) {
  const ws = new WebSocket('wss://ws.kraken.com/');
  ws.on('open', async () => {
    console.log('Kraken WS open. Subscribing:', pairsToUse.length, 'pairs');
    await subscribeInBatches(ws, pairsToUse);
  });
  ws.on('message', (buf) => {
    try {
      const obj = JSON.parse(buf.toString());
      if (obj.event) {
        if (obj.event === 'heartbeat') return;
        if (obj.event === 'subscriptionStatus') {
          if (obj.status !== 'subscribed') console.warn('Sub status', obj);
          return;
        }
        return;
      }
      const t = parseTickerMessage(obj);
      if (!t) return;
      const ts = Math.floor(Date.now() / 1000);
      computeVelocity(t.pair, ts, t.vol24, t.lastPrice, t.avg24);
    } catch (e) {
      console.error('WS parse err', e.message);
    }
  });
  ws.on('close', () => {
    console.warn('Kraken WS closed. Reconnecting in 3s…');
    setTimeout(() => startKraken(pairsToUse), 3000);
  });
  ws.on('error', (e) => {
    console.error('Kraken WS error', e.message);
    try { ws.close(); } catch {}
  });
}

// ================== DISCOVER ALL USD PAIRS (REST) ==================
async function discoverAllPairs() {
  try {
    const { data } = await axios.get('https://api.kraken.com/0/public/AssetPairs', { timeout: 20000 });
    if (!data || data.error?.length) throw new Error(data.error?.join(', ') || 'AssetPairs error');
    const entries = Object.values(data.result || {});
    let pairs = entries
      .map(x => x.wsname)                       // WebSocket pair name
      .filter(Boolean)
      .filter(n => n.endsWith(`/${KRAKEN_QUOTE}`));

    if (EXCLUDE_REGEX) pairs = pairs.filter(p => !EXCLUDE_REGEX.test(p));

    // Dedup & cap
    pairs = Array.from(new Set(pairs));
    const capped = pairs.slice(0, MAX_SUBSCRIBE_PAIRS);

    discoveredInfo = { total: pairs.length, using: capped.length, quote: KRAKEN_QUOTE };
    return capped;
  } catch (e) {
    console.error('Pair discovery failed:', e.message);
    return null;
  }
}

// ================== BOOT ==================
(async () => {
  if (KRAKEN_WS_PAIRS_RAW.trim().toUpperCase() === 'ALL') {
    const discovered = await discoverAllPairs();
    if (discovered && discovered.length) {
      WS_PAIRS = discovered;
    } else {
      // Fallback to a sane default if discovery failed
      WS_PAIRS = ['XBT/USD','ETH/USD','SOL/USD','SUI/USD'];
      console.warn('Using fallback pairs:', WS_PAIRS.join(', '));
    }
  } else {
    WS_PAIRS = KRAKEN_WS_PAIRS_RAW.split(',').map(s => s.trim()).filter(Boolean);
  }

  // Ensure state exists for each subscribed pair
  for (const p of WS_PAIRS) {
    if (!perPair[p]) perPair[p] = { last: null, buf: [], volVelPct: 0, priceChangePct: 0, diffPct: 0, alert: {} };
  }

  // Start WebSocket
  startKraken(WS_PAIRS);

  // Start server (bind 0.0.0.0 so curl to 127.0.0.1 works too)
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on :${PORT}`);
    console.log(`Open http://<your-ip>:${PORT}/`);
  });
})();
