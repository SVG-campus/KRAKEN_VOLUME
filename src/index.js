// src/index.js  (CommonJS for PM2)
require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const axios = require('axios');

/* ================== ENV / CONFIG ================== */
const PORT                  = Number(process.env.PORT || 3000);
const RANK_MODE             = (process.env.RANK_MODE || 'ratio');   // 'ratio' | 'volvel'
const RATE_WINDOW_SEC       = Number(process.env.RATE_WINDOW_SEC || 60);

// Alerting (legacy stepwise escalation — optional)
const ALERT_MODE            = (process.env.ALERT_MODE || 'digest'); // 'digest' | 'escalate' | 'both'
const ALERT_DIFF_THRESHOLD_PCT = Number(process.env.ALERT_DIFF_THRESHOLD_PCT || 5);     // base, e.g. 5%
const ALERT_LEVEL_STEP_PCT     = Number(process.env.ALERT_LEVEL_STEP_PCT || 1.25);      // steps, e.g. 1.25%
const ALERT_MIN_INTERVAL_SEC   = Number(process.env.ALERT_MIN_INTERVAL_SEC || 300);     // per-coin cool-down
const ALERT_MIN_MS             = ALERT_MIN_INTERVAL_SEC * 1000;

// Digest (anti-spam, sustained winners)
const DIGEST_WINDOW_SEC     = Number(process.env.DIGEST_WINDOW_SEC || 300);  // average window (default 5m)
const DIGEST_INTERVAL_SEC   = Number(process.env.DIGEST_INTERVAL_SEC || 120); // summary cadence
const DIGEST_TOP_N          = Number(process.env.DIGEST_TOP_N || 5);
const DIGEST_MIN_ABS_DIFF   = Number(process.env.DIGEST_MIN_ABS_DIFF || 3);   // ignore if |avgΔ| below this
const DIGEST_CHANGE_STEP_PCT= Number(process.env.DIGEST_CHANGE_STEP_PCT || ALERT_LEVEL_STEP_PCT); // re-post threshold
const DIGEST_INCLUDE_NEGATIVE = `${process.env.DIGEST_INCLUDE_NEGATIVE || 'false'}`.toLowerCase() === 'true';

const SLACK_WEBHOOK_URL     = process.env.SLACK_WEBHOOK_URL || '';
const PAPER                 = `${process.env.PAPER || 'true'}`.toLowerCase() !== 'false'; // unused but kept

// Pair selection
// - If KRAKEN_WS_PAIRS is "ALL", auto-discover pairs via REST.
// - Else, use provided comma-list.
const KRAKEN_WS_PAIRS_RAW   = process.env.KRAKEN_WS_PAIRS || 'SOL/USD,XBT/USD,ETH/USD,SUI/USD';
const KRAKEN_QUOTE          = process.env.KRAKEN_QUOTE || 'USD';
const MAX_SUBSCRIBE_PAIRS   = Number(process.env.MAX_SUBSCRIBE_PAIRS || 300);
const SUB_BATCH_SIZE        = Number(process.env.SUB_BATCH_SIZE || 25);
const SUB_BATCH_DELAY_MS    = Number(process.env.SUB_BATCH_DELAY_MS || 600);
const EXCLUDE_REGEX_STR     = process.env.KRAKEN_EXCLUDE_REGEX || ''; // e.g. '(USDT|EUR)'
const EXCLUDE_REGEX         = EXCLUDE_REGEX_STR ? new RegExp(EXCLUDE_REGEX_STR) : null;

/* ================== EXPRESS + SOCKET.IO ================== */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const frontendDistPath = path.join(__dirname, 'dist');
app.use(express.static(frontendDistPath));

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

let WS_PAIRS = []; // set during boot (env or discovery)
let discoveredInfo = { total: 0, using: 0, quote: KRAKEN_QUOTE };

app.get('/api/pairs', (_req, res) => {
  res.json({
    mode: (KRAKEN_WS_PAIRS_RAW.trim().toUpperCase() === 'ALL' ? 'auto' : 'env'),
    quote: KRAKEN_QUOTE,
    totalDiscovered: discoveredInfo.total,
    subscribed: discoveredInfo.using,
    pairs: WS_PAIRS,
  });
});

function pct(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
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
    const volVelPct = pct(S.volVelPct);
    const priceChangePct = pct(S.priceChangePct);
    const diffPct = pct(S.diffPct);
    pairs[p] = {
      ts: S.last.ts,
      price: S.last.price,
      avg24: S.last.avg24,
      vol24: S.last.vol24,
      volVelPct,
      priceChangePct,
      diffPct,
      ratio: Number(momentumScore({ volVelPct, priceChangePct }).toFixed(2)),
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
    ts: Math.floor(Date.now() / 1000),
    meta: { rankMode: RANK_MODE, quote: KRAKEN_QUOTE, subscribed: WS_PAIRS.length, alertMode: ALERT_MODE },
    pairs,
    top: ranked.slice(0, 5),
  };
}

app.get('/api/snapshot', (_req, res) => res.json(currentSnapshot()));

// Optional: expose current digest calc
app.get('/api/digest', (_req, res) => res.json(buildDigestReport()));

// Final SPA fallback (keep AFTER routes & static)
app.use((_req, res) => {
  res.sendFile(path.join(frontendDistPath, 'index.html'));
});

io.on('connection', (socket) => {
  socket.emit('hello', { ok: true, ts: Date.now() });
});

/* ================== SLACK ================== */
async function slack(text, blocks) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await axios.post(SLACK_WEBHOOK_URL, blocks ? { text, blocks } : { text });
  } catch (e) {
    console.error('Slack error', e.message);
  }
}

/* ================== STATE & COMPUTATION ================== */
// Pre-seed perPair only for explicit env list; auto-discovery will add later.
if (KRAKEN_WS_PAIRS_RAW.trim().toUpperCase() !== 'ALL') {
  for (const p of KRAKEN_WS_PAIRS_RAW.split(',').map(s => s.trim()).filter(Boolean)) {
    perPair[p] = { last: null, buf: [], volVelPct: 0, priceChangePct: 0, diffPct: 0, alert: { level: 0, lastAt: 0 } };
  }
}

function computeVelocity(pair, ts, vol24, price, avg24) {
  if (!perPair[pair]) perPair[pair] = { last: null, buf: [], volVelPct: 0, priceChangePct: 0, diffPct: 0, alert: {} };
  const S = perPair[pair];

  const HORIZON_SEC = Math.max(RATE_WINDOW_SEC * 6, 300);

  // Trim old samples (we will push the NEW sample AFTER computing)
  while (S.buf.length && ts - S.buf[0].ts > HORIZON_SEC) S.buf.shift();

  // Find an older sample ~RATE_WINDOW_SEC ago (or fallback)
  let older = S.buf.length ? S.buf[0] : { ts: ts - 1, vol24, diff: S.diffPct || 0, volVel: S.volVelPct || 0, price: S.priceChangePct || 0 };
  for (let i = S.buf.length - 1; i >= 0; i--) {
    if (ts - S.buf[i].ts >= RATE_WINDOW_SEC) { older = S.buf[i]; break; }
  }

  const dt = Math.max(1, ts - older.ts);
  const v0 = Math.max(older.vol24 || 0, 1e-9);
  const dv = vol24 - (older.vol24 || 0);

  const volVelPct = ((dv / v0) * (3600 / dt)) * 100;                        // %/h
  const priceChangePct = ((price - avg24) / Math.max(avg24, 1e-9)) * 100;   // %

  S.last = { ts, vol24, price, avg24 };
  S.volVelPct = volVelPct;
  S.priceChangePct = priceChangePct;
  S.diffPct = volVelPct - priceChangePct;

  // Push the NEW sample so digest/slope have history
  S.buf.push({ ts, vol24, diff: S.diffPct, volVel: S.volVelPct, price: S.priceChangePct });

  if (ALERT_MODE !== 'digest') {
    maybeEscalationAlert(pair); // optional legacy stepwise mode
  }
}

/* ===== Helpers for digest & escalation ===== */
function recentSlope(S) {
  // Rough d(diff)/dt over the last ~2 samples
  const n = S.buf.length;
  if (n < 2) return 0;
  const a = S.buf[Math.max(0, n - 3)];
  const b = S.buf[n - 1];
  const d = (b.diff - (a.diff ?? 0));
  const dt = Math.max(1, b.ts - a.ts);
  return d / dt; // % per second
}

// Quantize diff to signed levels (for stepwise alerts): …, -6.25, -5.00, 0, 5.00, 6.25, …
function quantizeLevel(diffPct) {
  const ad = Math.abs(diffPct);
  if (ad < ALERT_DIFF_THRESHOLD_PCT) return 0;
  const stepsAbove = Math.floor((ad - ALERT_DIFF_THRESHOLD_PCT) / ALERT_LEVEL_STEP_PCT) + 1; // 5.00→1, 6.25→2…
  const level = ALERT_DIFF_THRESHOLD_PCT + (stepsAbove - 1) * ALERT_LEVEL_STEP_PCT;
  const signed = level * Math.sign(diffPct);
  return Math.round(signed * 100) / 100; // avoid FP jitter
}

function maybeEscalationAlert(pair) {
  const S = perPair[pair];
  if (!S || !S.last) return;

  const diffNow = pct(S.diffPct);
  const newLevel = quantizeLevel(diffNow);
  const a = (S.alert ||= { level: 0, lastAt: 0 });
  const prevLevel = a.level;
  const now = Date.now();

  if (newLevel === prevLevel) return;
  if (now - a.lastAt < ALERT_MIN_MS) return;

  if (newLevel === 0 && prevLevel !== 0) {
    const emoji = prevLevel > 0 ? '🟢🔕' : '🔴🔕';
    slack(
      `${emoji} ${pair}: diff back *below ${ALERT_DIFF_THRESHOLD_PCT.toFixed(2)}%* (now ${pct(diffNow)}%). ` +
      `VolVel ${pct(S.volVelPct)}%/h • Price ${pct(S.priceChangePct)}%`
    );
    a.level = 0;
    a.lastAt = now;
    return;
  }

  const delta = Math.round((newLevel - prevLevel) * 100) / 100;
  const dir = delta > 0 ? 'UP' : 'DOWN';
  const arrow = delta > 0 ? '⬆️' : '⬇️';

  // Intensity by distance above base (cap at 5)
  const rank = Math.min(5, Math.floor((Math.abs(newLevel) - ALERT_DIFF_THRESHOLD_PCT) / ALERT_LEVEL_STEP_PCT) + 1);
  const flames = newLevel > 0 ? '🔥'.repeat(rank) : '🧊'.repeat(rank);

  const slope = recentSlope(S);         // % per second
  const perMin = pct(slope * 60);       // % per minute

  slack(
    `${flames} ${pair}: ${arrow} ${dir} ${Math.abs(delta).toFixed(2)}% to **${Math.abs(newLevel).toFixed(2)}% diff**\n` +
    `• VolVel ${pct(S.volVelPct)}%/h • Price ${pct(S.priceChangePct)}% • Diff ${pct(diffNow)}% • ~${perMin}%/min`
  );

  a.level = newLevel;
  a.lastAt = now;
}

/* ================== DIGEST MODE (anti-spam) ================== */
function avgFieldSimple(buf, windowSec, field) {
  if (!buf.length) return null;
  const cutoff = Math.floor(Date.now()/1000) - windowSec;
  const recent = buf.filter(x => x.ts >= cutoff);
  if (!recent.length) return null;
  let sum = 0;
  for (const r of recent) sum += Number(r[field] || 0);
  return sum / recent.length;
}

function buildDigestReport() {
  const rows = [];
  for (const p of WS_PAIRS) {
    const S = perPair[p];
    if (!S || !S.last || !S.buf.length) continue;

    const avgDiff = avgFieldSimple(S.buf, DIGEST_WINDOW_SEC, 'diff');
    if (avgDiff === null) continue;
    if (Math.abs(avgDiff) < DIGEST_MIN_ABS_DIFF) continue; // ignore weak signals

    const avgVolVel = avgFieldSimple(S.buf, DIGEST_WINDOW_SEC, 'volVel') ?? S.volVelPct;
    const avgPrice  = avgFieldSimple(S.buf, DIGEST_WINDOW_SEC, 'price')  ?? S.priceChangePct;
    const slopeMin  = pct(recentSlope(S) * 60);

    rows.push({
      pair: p,
      avgDiff: Number(avgDiff.toFixed(2)),
      avgVolVel: pct(avgVolVel),
      avgPrice: pct(avgPrice),
      trendPerMin: slopeMin,
      lastPrice: S.last.price,
      ts: S.last.ts
    });
  }

  // Winners = positive avgDiff; Losers = negative avgDiff (optional)
  const winners = rows.filter(r => r.avgDiff >= 0).sort((a,b) => b.avgDiff - a.avgDiff).slice(0, DIGEST_TOP_N);
  const losers  = DIGEST_INCLUDE_NEGATIVE
    ? rows.filter(r => r.avgDiff < 0).sort((a,b) => a.avgDiff - b.avgDiff).slice(0, DIGEST_TOP_N)
    : [];

  return {
    ts: Math.floor(Date.now()/1000),
    windowSec: DIGEST_WINDOW_SEC,
    topWinners: winners,
    topLosers: losers
  };
}

const digestState = { lastTopSymbols: [], lastLeader: null, lastLeaderDiff: null, lastSentAt: 0 };

function rankEmoji(rank) {
  // rank is 1-based
  if (rank === 1) return '👑🚀🔥';
  if (rank === 2) return '🚀🔥';
  if (rank === 3) return '🚀';
  if (rank === 4) return '✨';
  return '•';
}

function shouldSendDigest(rep) {
  const winners = rep.topWinners;
  if (!winners.length) return false;

  const topSymbols = winners.map(w => w.pair).join(',');
  const leader = winners[0];
  const changedMembership = topSymbols !== digestState.lastTopSymbols.join(',');

  const diffJump = (digestState.lastLeaderDiff == null)
    ? true
    : Math.abs(leader.avgDiff - digestState.lastLeaderDiff) >= DIGEST_CHANGE_STEP_PCT;

  return changedMembership || diffJump;
}

function postDigest(rep) {
  const winners = rep.topWinners;
  const losers = rep.topLosers;

  const header = `🧭 Kraken Volume • ${Math.round(rep.windowSec/60)}m digest • Top ${DIGEST_TOP_N} by sustained Δ (volVel - price)`;
  const lines = [];

  winners.forEach((w, i) => {
    const r = i + 1;
    const em = rankEmoji(r);
    const trendArrow = w.trendPerMin > 0 ? '↗︎' : (w.trendPerMin < 0 ? '↘︎' : '→');
    lines.push(`${em} ${r}) *${w.pair}* — avgΔ=${w.avgDiff}%  (volVel=${w.avgVolVel}%/h, price=${w.avgPrice}%, trend ~${w.trendPerMin}%/min ${trendArrow})`);
  });

  if (losers.length) {
    lines.push(`\n🔻 Top ${losers.length} negative (sustained):`);
    losers.forEach((w, i) => {
      const r = i + 1;
      const trendArrow = w.trendPerMin > 0 ? '↗︎' : (w.trendPerMin < 0 ? '↘︎' : '→');
      lines.push(`• ${r}) *${w.pair}* — avgΔ=${w.avgDiff}%  (volVel=${w.avgVolVel}%/h, price=${w.avgPrice}%, trend ~${w.trendPerMin}%/min ${trendArrow})`);
    });
  }

  slack(`${header}\n${lines.join('\n')}`);

  // update state
  digestState.lastTopSymbols = winners.map(w => w.pair);
  digestState.lastLeader = winners[0].pair;
  digestState.lastLeaderDiff = winners[0].avgDiff;
  digestState.lastSentAt = Date.now();
}

/* Fire digest summaries on a timer */
if (ALERT_MODE !== 'escalate') {
  setInterval(() => {
    try {
      const rep = buildDigestReport();
      if (shouldSendDigest(rep)) postDigest(rep);
    } catch (e) {
      console.error('digest error', e.message);
    }
  }, DIGEST_INTERVAL_SEC * 1000);
}

/* ================== WS SNAPSHOT PUSH ================== */
// still stream snapshots to the UI every 2s
setInterval(() => { io.emit('snapshot', currentSnapshot()); }, 2000);

/* ================== KRAKEN WS ================== */
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

/* ================== DISCOVER ALL USD PAIRS (REST) ================== */
async function discoverAllPairs() {
  try {
    const { data } = await axios.get('https://api.kraken.com/0/public/AssetPairs', { timeout: 20000 });
    if (!data || (data.error && data.error.length)) {
      throw new Error(data.error?.join(', ') || 'AssetPairs error');
    }
    const entries = Object.values(data.result || {});
    let pairs = entries
      .map(x => x.wsname)
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

/* ================== BOOT ================== */
(async () => {
  if (KRAKEN_WS_PAIRS_RAW.trim().toUpperCase() === 'ALL') {
    const discovered = await discoverAllPairs();
    if (discovered && discovered.length) {
      WS_PAIRS = discovered;
    } else {
      WS_PAIRS = ['XBT/USD', 'ETH/USD', 'SOL/USD', 'SUI/USD'];
      console.warn('Using fallback pairs:', WS_PAIRS.join(', '));
    }
  } else {
    WS_PAIRS = KRAKEN_WS_PAIRS_RAW.split(',').map(s => s.trim()).filter(Boolean);
  }

  // Ensure state exists for each subscribed pair
  for (const p of WS_PAIRS) {
    if (!perPair[p]) perPair[p] = { last: null, buf: [], volVelPct: 0, priceChangePct: 0, diffPct: 0, alert: { level: 0, lastAt: 0 } };
  }

  // Start WebSocket
  startKraken(WS_PAIRS);

  // Start server (bind 0.0.0.0 so local curl works)
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on :${PORT}`);
    console.log(`Open http://<your-ip>:${PORT}/`);
  });
})();
