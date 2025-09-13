const express = require("express");
// src/index.js  (CommonJS for PM2)
require('dotenv').config({ quiet: true });
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const axios = require('axios');

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 3000);
const KRAKEN_WS_URL = process.env.KRAKEN_WS_URL || 'wss://ws.kraken.com/';
const WS_PAIRS = (process.env.KRAKEN_WS_PAIRS || 'SOL/USD,XBT/USD,ETH/USD')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const RATE_WINDOW_SEC = Number(process.env.RATE_WINDOW_SEC || 60); // min window to compare volume
const ALERT_THRESHOLD = Number(process.env.ALERT_THRESHOLD_PCT || 10); // divergence threshold (%)
const ALERT_MIN_INTERVAL_SEC = Number(process.env.ALERT_MIN_INTERVAL_SEC || 300); // re-notify window
const RANK_MODE = (process.env.RANK_MODE || 'ratio'); // 'ratio' | 'volvel'
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const PAPER = `${process.env.PAPER || 'true'}`.toLowerCase() !== 'false'; // not used, but kept

// ---------- Express + Socket.IO ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve the Vite build from src/dist (because index.js lives in src/)
const frontendDistPath = path.join(__dirname, 'dist');
app.use(express.static(frontendDistPath));

// --- simple health + debug JSON ---
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.get('/api/pairs', (_req, res) => res.json({ pairs: WS_PAIRS }));

// ---------- State & helpers ----------
const perPair = Object.create(null); // { [pair]: { last, buf, volVelPct, priceChangePct, diffPct } }
for (const p of WS_PAIRS) perPair[p] = { last: null, buf: [], volVelPct: 0, priceChangePct: 0, diffPct: 0 };

function pct(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
function roundTo(n, d = 2) { return Number.isFinite(n) ? Number(n.toFixed(d)) : 0; }

function momentumScore(s) {
  // ratio of velocity to absolute price change; avoid /0
  const denom = Math.max(0.0001, Math.abs(Number(s.priceChangePct || 0)));
  return Number(s.volVelPct || 0) / denom;
}

function currentSnapshot() {
  const pairs = {};
  for (const p of WS_PAIRS) {
    const S = perPair[p];
    if (!S.last) continue;
    pairs[p] = {
      ts: S.last.ts,
      price: S.last.price,
      avg24: S.last.avg24,
      vol24: S.last.vol24,
      volVelPct: pct(S.volVelPct),
      priceChangePct: pct(S.priceChangePct),
      diffPct: pct(S.diffPct),
      ratio: roundTo(momentumScore({ volVelPct: S.volVelPct, priceChangePct: S.priceChangePct }), 2),
    };
  }

  const ranked = Object.entries(pairs)
    .sort((a, b) => {
      const as = (RANK_MODE === 'ratio') ? momentumScore(a[1]) : a[1].volVelPct;
      const bs = (RANK_MODE === 'ratio') ? momentumScore(b[1]) : b[1].volVelPct;
      return bs - as;
    })
    .map(([k]) => k);

  return { ts: Math.floor(Date.now() / 1000), pairs, top: ranked.slice(0, 2) };
}

app.get('/api/snapshot', (_req, res) => res.json(currentSnapshot()));

// Final SPA fallback (keep AFTER routes & static)
app.use((_req, res) => {
  res.sendFile(path.join(frontendDistPath, 'index.html'));
});

io.on('connection', (socket) => {
  socket.emit('hello', { ok: true, ts: Date.now() });
});

// ---------- Slack ----------
async function slack(text, blocks) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('[SLACK]', text);
    return;
  }
  try {
    await axios.post(SLACK_WEBHOOK_URL, blocks ? { text, blocks } : { text });
  } catch (e) {
    console.error('Slack error', e.message);
  }
}

// ---------- Velocity calc ----------
function computeVelocity(pair, ts, vol24, price, avg24) {
  const S = perPair[pair];
  const HORIZON_SEC = Math.max(RATE_WINDOW_SEC * 6, 300);

  S.buf.push({ ts, vol24 });
  while (S.buf.length && ts - S.buf[0].ts > HORIZON_SEC) S.buf.shift();

  // find point at least RATE_WINDOW_SEC ago (or oldest)
  let older = S.buf[0];
  for (let i = S.buf.length - 1; i >= 0; i--) {
    if (ts - S.buf[i].ts >= RATE_WINDOW_SEC) { older = S.buf[i]; break; }
  }

  const dt = Math.max(1, ts - older.ts);
  const v0 = Math.max(older.vol24 || 0, 1e-9);
  const dv = vol24 - (older.vol24 || 0);

  // % change in 24h volume per hour
  const volVelPct = ((dv / v0) * (3600 / dt)) * 100;
  // price vs 24h average
  const priceChangePct = ((price - avg24) / Math.max(avg24, 1e-9)) * 100;

  S.last = { ts, vol24, price, avg24 };
  S.volVelPct = volVelPct;
  S.priceChangePct = priceChangePct;
  S.diffPct = volVelPct - priceChangePct;
}

// Broadcast snapshots to UI every 2s
setInterval(() => { io.emit('snapshot', currentSnapshot()); }, 2000);

// ---------- Divergence alerts (vol vs price) ----------
const alertState = Object.create(null); // { [pair]: { ts, delta } }

function topMode() {
  return RANK_MODE === 'ratio' ? 'ratio' : 'velocity';
}
function formatDeltaGain(g) {
  if (!Number.isFinite(g) || g <= 0) return '';
  return `  |  +${g}% since last alert`;
}
function pickEmoji(deltaGain) {
  if (deltaGain >= 3) return '🚀';
  if (deltaGain >= 1.5) return '📈';
  return '↗️';
}

function checkAlerts() {
  const snap = currentSnapshot();
  const leader = snap.top?.[0];

  for (const [pair, s] of Object.entries(snap.pairs)) {
    const vol   = Number(s.volVelPct || 0);
    const px    = Number(s.priceChangePct || 0);
    const delta = Number((vol - px).toFixed(2));         // divergence we care about
    const upTrend = vol > 0 && px > 0;                   // “going up”
    if (!upTrend || delta < ALERT_THRESHOLD) continue;   // need +10% (or env) while rising

    const prev = alertState[pair] || { ts: 0, delta: 0 };
    const now = Math.floor(Date.now() / 1000);
    const deltaGain = Number((delta - prev.delta).toFixed(2));
    const longEnough     = (now - prev.ts) >= ALERT_MIN_INTERVAL_SEC; // time-based keep-reminding
    const meaningfulMove = deltaGain >= 1.0;                           // or ≥ +1% more divergence since last

    if (longEnough || meaningfulMove) {
      const crown  = leader === pair ? ' 👑' : '';
      const emoji  = pickEmoji(deltaGain);
      const msg =
        `🔥⚡ *Divergence Alert*${crown}\n` +
        `*${pair}*: Δ = *${delta}%* (vel ${vol}%, price ${px}%) ${emoji}` +
        formatDeltaGain(deltaGain) +
        `  |  Top by ${topMode()}: ${leader ?? 'n/a'}`;

      slack(msg);
      alertState[pair] = { ts: now, delta };
    }
  }
}

// run every 30s; will keep reminding while condition persists / grows
setInterval(checkAlerts, 30 * 1000);

// ---------- Kraken WS “ticker” ----------
function krakenSubscribe(ws, pairs) {
  ws.send(JSON.stringify({ event: 'subscribe', pair: pairs, subscription: { name: 'ticker' } }));
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

function startKraken() {
  const ws = new WebSocket(KRAKEN_WS_URL);

  ws.on('open', () => {
    console.log('Kraken WS open. Subscribing:', WS_PAIRS.join(', '));
    krakenSubscribe(ws, WS_PAIRS);
  });

  ws.on('message', (buf) => {
    try {
      const obj = JSON.parse(buf.toString());
      if (obj && obj.event) {
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
      // alerts are handled by checkAlerts() timer
    } catch (e) {
      console.error('WS parse err', e.message);
    }
  });

  ws.on('close', () => {
    console.warn('Kraken WS closed. Reconnecting in 3s…');
    setTimeout(startKraken, 3000);
  });

  ws.on('error', (e) => {
    console.error('Kraken WS error', e.message);
    try { ws.close(); } catch {}
  });
}

startKraken();

// ---------- Start server ----------
server.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`Open http://<your-ip>:${PORT}/`);
});

// SPA fallback: serve built index.html for any route not handled above
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});
