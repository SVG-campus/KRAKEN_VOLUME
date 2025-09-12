import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { ProxyAgent } from 'undici';
import { calcVolumePctChange, calcPriceChangePct, calcVolumeVelocity } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;

const pairs = (process.env.KRAKEN_PAIRS || 'XXBTZUSD,SOLUSD').split(',').map(p => p.trim()).filter(Boolean);
const slackWebhook = process.env.SLACK_WEBHOOK_URL;
const interval = Number(process.env.POLL_INTERVAL_MS) || 30000; // default 30s
const PORT = process.env.PORT || 3000;

const state = {}; // pair -> { volume, pct }
let latestResults = []; // a cache of the latest results for new clients

async function fetchTickers() {
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pairs.join(',')}`, { dispatcher });
  const data = await res.json();
  if (data.error && data.error.length) {
    throw new Error(data.error.join(', '));
  }
  return data.result;
}

async function sendSlack(message) {
  if (!slackWebhook) return;
  await fetch(slackWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
    dispatcher
  });
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');
  // Send the latest results immediately on connection
  if (latestResults.length > 0) {
    ws.send(JSON.stringify({ type: 'update', data: latestResults }));
  }
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

async function check() {
  try {
    const tickers = await fetchTickers();
    const results = [];

    for (const [pair, ticker] of Object.entries(tickers)) {
      const volume24h = parseFloat(ticker.v[1]);
      const lastPrice = parseFloat(ticker.c[0]);
      const openPrice = parseFloat(ticker.o);
      const priceChangePct = calcPriceChangePct(openPrice, lastPrice);
      const prev = state[pair];
      const volumePctChange = calcVolumePctChange(prev?.volume ?? null, volume24h);
      const volumeVelocity = prev && volumePctChange !== null
        ? calcVolumeVelocity(prev.pct, volumePctChange, interval)
        : null;
      state[pair] = { volume: volume24h, pct: volumePctChange };
      const diff = volumePctChange === null ? null : volumePctChange - priceChangePct;
      results.push({ pair, volumePctChange, priceChangePct, diff, volumeVelocity });
      if (diff !== null && Math.abs(diff) >= 10) {
        await sendSlack(`Kraken ${pair}: volume ${volumePctChange.toFixed(2)}% price ${priceChangePct.toFixed(2)}% diff ${diff.toFixed(2)}% velocity ${volumeVelocity !== null ? volumeVelocity.toFixed(2) : 'n/a'}%/h`);
      }
    }

    latestResults = results; // cache the results

    // Broadcast the new results to all connected WebSocket clients
    broadcast({ type: 'update', data: results });

    const ranked = results.filter(r => r.volumeVelocity !== null).sort((a, b) => b.volumeVelocity - a.volumeVelocity);
    if (ranked.length === 0) {
      console.log('Waiting for baseline volume data...');
    } else {
      const top = ranked[0];
      const second = ranked[1];
      const msg = `${new Date().toISOString()} | Top: ${top.pair} (${top.volumeVelocity.toFixed(2)}%/h)` + (second ? ` | Second: ${second.pair} (${second.volumeVelocity.toFixed(2)}%/h)` : '');
      console.log(msg);
    }
  } catch (err) {
    console.error('Error fetching ticker', err);
  }
}

// Serve the built frontend
const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDistPath));

// API endpoint to get initial data
app.get('/api/data', (req, res) => {
  res.json(latestResults);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  // Start polling
  check();
  setInterval(check, interval);
});
