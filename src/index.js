// src/index.js  (CommonJS for PM2)
require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const axios = require('axios');

// ================== ENV / CONFIG ==================
const PORT                      = Number(process.env.PORT || 3000);
const RANK_MODE                 = (process.env.RANK_MODE || 'ratio');   // 'ratio' | 'vol'
const RATE_WINDOW_SEC           = Number(process.env.RATE_WINDOW_SEC || 60); // short-term slope window (sec)

// 24h-style lookback (you can shorten for warm-up/testing, e.g. 6)
const LOOKBACK_HOURS            = Number(process.env.LOOKBACK_HOURS || 24);
const DAYBUF_RES_SEC            = Number(process.env.DAYBUF_RES_SEC || 60); // 1 entry per minute
const DAYBUF_KEEP_HRS           = Math.max(LOOKBACK_HOURS + 2, 26);        // keep ~26h

// Alerting (step alerts can be fully disabled)
const ALERT_DIFF_THRESHOLD_PCT  = Number(process.env.ALERT_DIFF_THRESHOLD_PCT || 5);     // base, e.g. 5%
const ALERT_LEVEL_STEP_PCT      = Number(process.env.ALERT_LEVEL_STEP_PCT || 1.25);      // steps, e.g. 1.25%
const ALERT_MIN_INTERVAL_SEC    = Number(process.env.ALERT_MIN_INTERVAL_SEC || 300);     // per-coin cool-down
const ALERT_MIN_MS              = ALERT_MIN_INTERVAL_SEC * 1000;
const STEP_ALERTS_ENABLED       = `${process.env.STEP_ALERTS_ENABLED || 'true'}`.toLowerCase() === 'true';

// Digest (anti-spam)
const DIGEST_EVERY_SEC          = Number(process.env.DIGEST_EVERY_SEC || 300);
const DIGEST_TOP_N              = Number(process.env.DIGEST_TOP_N || 10);
const DIGEST_MIN_ABS_DELTA_PCT  = Number(process.env.DIGEST_MIN_ABS_DELTA_PCT || 3);     // ignore tiny moves
const DIGEST_INCLUDE_LOSERS     = `${process.env.DIGEST_INCLUDE_LOSERS || 'true'}`.toLowerCase() === 'true';
const DIGEST_WINDOW_SEC         = Number(process.env.DIGEST_WINDOW_SEC || 300);          // e.g., 5m sustained avg
const DIGEST_STREAK_CROWN_MIN   = Number(process.env.DIGEST_STREAK_CROWN_MIN || 2);      // consecutive digests
const DIGEST_CROWN_WINDOW_SEC   = Number(process.env.DIGEST_CROWN_WINDOW_SEC || 3600);   // hits window for 👑

// Slack/web
const SLACK_WEBHOOK_URL         = process.env.SLACK_WEBHOOK_URL || '';
const PAPER                     = `${process.env.PAPER || 'true'}`.toLowerCase() !== 'false'; // not used here

// Pair selection
// - If KRAKEN_WS_PAIRS is "ALL", auto-discover pairs via REST.
// - Else, use provided comma-list.
const KRAKEN_WS_PAIRS_RAW       = process.env.KRAKEN_WS_PAIRS || 'SOL/USD,XBT/USD,ETH/USD,SUI/USD';
const KRAKEN_QUOTE              = process.env.KRAKEN_QUOTE || 'USD';
const MAX_SUBSCRIBE_PAIRS       = Number(process.env.MAX_SUBSCRIBE_PAIRS || 300);
const SUB_BATCH_SIZE            = Number(process.env.SUB_BATCH_SIZE || 25);
const SUB_BATCH_DELAY_MS        = Number(process.env.SUB_BATCH_DELAY_MS || 600);
const EXCLUDE_REGEX_STR         = process.env.KRAKEN_EXCLUDE_REGEX || ''; // e.g. '(USDT|EUR)'
const EXCLUDE_REGEX             = EXCLUDE_REGEX_STR ? new RegExp(EXCLUDE_REGEX_STR) : null;

// ================== EXPRESS + SOCKET.IO ==================
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
function nonneg(n, eps = 1e-9) { return Math.max(eps, n || 0); }

// Accept either {vol24Pct, price24Pct} OR legacy names {volVelPct, priceChangePct}
function momentumScore(s) {
  const price = Number(s.price24Pct ?? s.priceChangePct ?? 0);
  const vol   = Number(s.vol24Pct   ?? s.volVelPct      ?? 0);
  const denom = Math.max(0.0001, Math.abs(price));
  return vol / denom;
}

// ================== STATE ==================
/*
 perPair[pair] = {
   last: { ts, price, avg24, vol24 },
   // minute-resolution history for ~26h
   daybuf: [{ ts, vol24, price }, ...],
   lastMinuteBucket: 0,
   // latest 24h-comparative percentages
   vol24Pct: 0,
   price24Pct: 0,
   diffPct: 0,
   // short buffer for slope + digest (~10m+)
   buf: [{ ts, diff: number }...],
   // alerts/digest meta
   alert: { level: 0, lastAt: 0, hits: 0, hitsWindowStart: 0 },
   digestStreak: 0
 }
*/
const perPair = Object.create(null);

// ================== SNAPSHOT ==================
function currentSnapshot() {
  const pairs = {};
  for (const p of WS_PAIRS) {
    const S = perPair[p];
    if (!S || !S.last) continue;
    const vol24Pct = pct(S.vol24Pct);
    const price24Pct = pct(S.price24Pct);
    const diffPct = pct(S.diffPct);
    pairs[p] = {
      ts: S.last.ts,
      price: S.last.price,
      avg24: S.last.avg24,     // passthrough (not used in calc)
      vol24: S.last.vol24,
      // Keep legacy field names so UI keeps working, but values are 24h-based now:
      volVelPct: vol24Pct,         // === 24h volume % vs previous 24h
      priceChangePct: price24Pct,  // === price % vs 24h ago
      diffPct,
      ratio: Number(momentumScore({ vol24Pct, price24Pct }).toFixed(2)),
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
    meta: {
      rankMode: RANK_MODE,
      quote: KRAKEN_QUOTE,
      subscribed: WS_PAIRS.length,
      lookbackHours: LOOKBACK_HOURS
    },
    pairs,
    top: ranked.slice(0, 5),
  };
}

app.get('/api/snapshot', (_req, res) => res.json(currentSnapshot()));

// Final SPA fallback (keep AFTER routes & static)
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

// ================== COMPUTATION ==================
function ensureState(pair) {
  if (!perPair[pair]) {
    perPair[pair] = {
      last: null,
      daybuf: [],
      lastMinuteBucket: 0,
      vol24Pct: 0,
      price24Pct: 0,
      diffPct: 0,
      buf: [],
      alert: { level: 0, lastAt: 0, hits: 0, hitsWindowStart: 0 },
      digestStreak: 0
    };
  }
  return perPair[pair];
}

function pushMinuteSample(S, ts, vol24, price) {
  const bucket = Math.floor(ts / DAYBUF_RES_SEC);
  if (S.lastMinuteBucket === bucket) return;
  S.lastMinuteBucket = bucket;

  S.daybuf.push({ ts, vol24, price });

  // trim to ~DAYBUF_KEEP_HRS
  const keepSec = DAYBUF_KEEP_HRS * 3600;
  const cutoff = ts - keepSec;
  while (S.daybuf.length && S.daybuf[0].ts < cutoff) S.daybuf.shift();
}

// find sample ~LOOKBACK_HOURS ago (choose the latest <= target)
function sampleAtLookback(S, ts) {
  if (!S.daybuf.length) return null;
  const target = ts - LOOKBACK_HOURS * 3600;
  // linear scan backward (minute spacing, ~1440 steps worst-case)
  for (let i = S.daybuf.length - 1; i >= 0; i--) {
    if (S.daybuf[i].ts <= target) return S.daybuf[i];
  }
  return null;
}

// short-term slope for trend (~last 2–3 samples of diffPct)
function recentSlope(S) {
  const n = S.buf.length;
  if (n < 2) return 0;
  const a = S.buf[Math.max(0, n - 3)];
  const b = S.buf[n - 1];
  const d = (b.diff - (a.diff ?? 0));
  const dt = Math.max(1, b.ts - a.ts);
  return d / dt; // % per second
}

function computeFromTicker(pair, ts, vol24, price, avg24) {
  const S = ensureState(pair);

  // keep minute-resolution history for ~26h
  pushMinuteSample(S, ts, vol24, price);

  // Need a lookback sample to compute true 24h style comparisons
  const ref = sampleAtLookback(S, ts);
  if (!ref) {
    // not enough history yet; still update 'last' so UI shows price etc.
    S.last = { ts, vol24, price, avg24 };
    return;
  }

  // 24h-volume % vs previous 24h window
  const vol24Pct = ((vol24 - ref.vol24) / nonneg(ref.vol24)) * 100;

  // price % vs 24h-ago price
  const price24Pct = ((price - ref.price) / nonneg(ref.price)) * 100;

  const diffPct = vol24Pct - price24Pct;

  S.last = { ts, vol24, price, avg24 };
  S.vol24Pct = vol24Pct;
  S.price24Pct = price24Pct;
  S.diffPct = diffPct;

  // short buffer (~10m+) used for trend + digest
  const HORIZON_SEC = Math.max(RATE_WINDOW_SEC * 10, 600);
  S.buf.push({ ts, diff: diffPct });
  while (S.buf.length && ts - S.buf[0].ts > HORIZON_SEC) S.buf.shift();

  maybeAlert(pair);
}

// ================== ALERTS (1.25% steps, both directions) ==================
function quantizeLevel(diffPct) {
  const ad = Math.abs(diffPct);
  if (ad < ALERT_DIFF_THRESHOLD_PCT) return 0;
  const stepsAbove = Math.floor((ad - ALERT_DIFF_THRESHOLD_PCT) / ALERT_LEVEL_STEP_PCT) + 1; // 5→1, 6.25→2…
  const level = ALERT_DIFF_THRESHOLD_PCT + (stepsAbove - 1) * ALERT_LEVEL_STEP_PCT;
  return Math.round(level * Math.sign(diffPct) * 100) / 100;
}

function maybeAlert(pair) {
  const S = perPair[pair];
  if (!S || !S.last) return;

  const diffNow = pct(S.diffPct);
  const newLevel = quantizeLevel(diffNow);
  const a = (S.alert ||= { level: 0, lastAt: 0, hits: 0, hitsWindowStart: 0 });
  const prevLevel = a.level;
  const now = Date.now();

  // Count virtual step hits for crown logic
  if (newLevel !== prevLevel && newLevel !== 0) {
    if (!a.hitsWindowStart || (now - a.hitsWindowStart) > DIGEST_CROWN_WINDOW_SEC * 1000) {
      a.hitsWindowStart = now; a.hits = 0;
    }
    a.hits++;
  }

  // If step alerts are disabled, just record state and bail
  if (!STEP_ALERTS_ENABLED) { a.level = newLevel; a.lastAt = now; return; }

  // (Live alerts path)
  if (newLevel === prevLevel) return;
  if (now - a.lastAt < ALERT_MIN_MS) return;

  if (newLevel === 0 && prevLevel !== 0) {
    const emoji = prevLevel > 0 ? '🟢🔕' : '🔴🔕';
    slack(
      `${emoji} ${pair}: diff back *below ${ALERT_DIFF_THRESHOLD_PCT.toFixed(2)}%* (now ${pct(diffNow)}%).\n` +
      `• Vol24% ${pct(S.vol24Pct)} • Price24% ${pct(S.price24Pct)}`
    );
    a.level = 0;
    a.lastAt = now;
    return;
  }

  const delta = Math.round((newLevel - prevLevel) * 100) / 100;
  const dir = delta > 0 ? 'UP' : 'DOWN';
  const arrow = delta > 0 ? '⬆️' : '⬇️';
  const rank = Math.min(5, Math.floor((Math.abs(newLevel) - ALERT_DIFF_THRESHOLD_PCT) / ALERT_LEVEL_STEP_PCT) + 1);
  const flames = newLevel > 0 ? '🔥'.repeat(rank) : '🧊'.repeat(rank);
  const perMin = pct(recentSlope(S) * 60); // %/min

  slack(
    `${flames} ${pair}: ${arrow} ${dir} ${Math.abs(delta).toFixed(2)}% to **${Math.abs(newLevel).toFixed(2)}% diff**\n` +
    `• Vol24% ${pct(S.vol24Pct)} • Price24% ${pct(S.price24Pct)} • Diff ${pct(diffNow)} • ~${perMin}%/min`
  );

  a.level = newLevel;
  a.lastAt = now;
}

// ================== DIGEST: winners + losers + crowns ==================
function avgDeltaOverWindow(S, nowSec, winSec) {
  if (!S || !S.buf || S.buf.length === 0) return 0;
  const t0 = nowSec - winSec;
  let sum = 0, cnt = 0;
  for (let i = S.buf.length - 1; i >= 0; i--) {
    const e = S.buf[i]; if (!e) continue;
    if (e.ts < t0) break;
    sum += (e.diff ?? 0); cnt++;
  }
  return cnt ? (sum / cnt) : 0;
}

function emojiForRank(i, isLoser = false) {
  if (isLoser) return ['🧊❄️','🧊','🧊','🥶','🥶','🧊','🧊','🧊','🧊','🧊'][i] || '🧊';
  return ['👑🚀🔥','🚀🔥','🚀','✨','✨','⭐','⭐','•','•','•'][i] || '•';
}

function buildLine(i, pair, stats, isLoser) {
  const mark = emojiForRank(i, isLoser);
  const crown = stats.crowned ? ' 👑' : '';
  const arrow = stats.trendPerMin >= 0 ? '↗︎' : '↘︎';
  return `${mark}${crown} ${i+1}) ${pair} — avgΔ=${pct(stats.avgDelta)}% ` +
         `(vol24=${pct(stats.vPct)}%, price24=${pct(stats.pPct)}%, trend ~${pct(stats.trendPerMin)}%/min ${arrow})`;
}

function sendDigest() {
  const nowSec = Math.floor(Date.now()/1000);
  const rows = [];

  for (const pair of WS_PAIRS) {
    const S = perPair[pair]; if (!S || !S.last) continue;

    const vPct = (S.vol24Pct !== undefined) ? S.vol24Pct : 0;
    const pPct = (S.price24Pct !== undefined) ? S.price24Pct : 0;
    const avgD = avgDeltaOverWindow(S, nowSec, DIGEST_WINDOW_SEC);
    if (!Number.isFinite(avgD)) continue;

    const slope = recentSlope(S), perMin = slope * 60;

    const crownedByHits =
      (S.alert?.hits || 0) >= 2 &&
      (Date.now() - (S.alert?.hitsWindowStart || 0) < DIGEST_CROWN_WINDOW_SEC*1000);

    rows.push([pair, {
      vPct, pPct,
      avgDelta: avgD,
      trendPerMin: perMin,
      crowned: crownedByHits || (S.digestStreak >= DIGEST_STREAK_CROWN_MIN)
    }]);
  }

  // Filter out tiny moves
  const filtered = rows.filter(([_p,s]) => Math.abs(s.avgDelta) >= DIGEST_MIN_ABS_DELTA_PCT);
  if (!filtered.length) return;

  // Winners & Losers
  const winners = filtered
    .filter(([_p,s]) => s.avgDelta >= 0)
    .sort((a,b) => b[1].avgDelta - a[1].avgDelta)
    .slice(0, DIGEST_TOP_N);

  const losers = DIGEST_INCLUDE_LOSERS ? filtered
    .filter(([_p,s]) => s.avgDelta < 0)
    .sort((a,b) => a[1].avgDelta - b[1].avgDelta)
    .slice(0, DIGEST_TOP_N) : [];

  // Update digest streaks
  const included = new Set([...winners, ...losers].map(([p]) => p));
  for (const p of WS_PAIRS) {
    const S = perPair[p]; if (!S) continue;
    if (included.has(p)) S.digestStreak = (S.digestStreak || 0) + 1;
    else S.digestStreak = 0;
  }

  // Build Slack text
  const title = `🧭 Kraken Volume • ${Math.round(DIGEST_WINDOW_SEC/60)}m digest • Top ${DIGEST_TOP_N} winners & losers (sustained Δ = vol24% - price24%)`;
  const lines = [];
  if (winners.length) {
    lines.push(`*Winners*`);
    winners.forEach(([_p,s],i) => lines.push(buildLine(i, _p, s, false)));
  }
  if (losers.length) {
    lines.push(`\n*Losers*`);
    losers.forEach(([_p,s],i) => lines.push(buildLine(i, _p, s, true)));
  }

  slack(`${title}\n${lines.join('\n')}`);
}

// fire digest every DIGEST_EVERY_SEC
setInterval(sendDigest, Math.max(60, DIGEST_EVERY_SEC) * 1000);

// Broadcast UI snapshots every 2s
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
  const vol24 = parseFloat(data.v?.[1] || '0'); // 24h base volume (rolling)
  const avg24 = parseFloat(data.p?.[1] || '0'); // 24h VWAP (not used in calc now)
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
      computeFromTicker(t.pair, ts, t.vol24, t.lastPrice, t.avg24);
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
    if (!data || (data.error && data.error.length)) {
      throw new Error(data.error?.join(', ') || 'AssetPairs error');
    }
    const entries = Object.values(data.result || {});
    let pairs = entries
      .map(x => x.wsname)
      .filter(Boolean)
      .filter(n => n.endsWith(`/${KRAKEN_QUOTE}`));

    if (EXCLUDE_REGEX) pairs = pairs.filter(p => !EXCLUDE_REGEX.test(p));

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
    WS_PAIRS = (discovered && discovered.length) ? discovered : ['XBT/USD','ETH/USD','SOL/USD','SUI/USD'];
    if (!discovered) console.warn('Using fallback pairs:', WS_PAIRS.join(', '));
  } else {
    WS_PAIRS = KRAKEN_WS_PAIRS_RAW.split(',').map(s => s.trim()).filter(Boolean);
  }

  for (const p of WS_PAIRS) ensureState(p);

  startKraken(WS_PAIRS);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on :${PORT}`);
    console.log(`Open http://<your-ip>:${PORT}/`);
  });
})();
