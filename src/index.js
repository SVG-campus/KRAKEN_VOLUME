import 'dotenv/config';
import { ProxyAgent } from 'undici';
import { calcVolumePctChange, calcPriceChangePct, calcVolumeVelocity } from './utils.js';

const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;

const pairs = (process.env.KRAKEN_PAIRS || 'XXBTZUSD,SOLUSD').split(',').map(p => p.trim()).filter(Boolean);
const slackWebhook = process.env.SLACK_WEBHOOK_URL;
const interval = Number(process.env.POLL_INTERVAL_MS) || 30000; // default 30s

const state = {}; // pair -> { volume, pct }

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

    const ranked = results.filter(r => r.volumeVelocity !== null).sort((a, b) => b.volumeVelocity - a.volumeVelocity);
    if (ranked.length === 0) {
      console.log('Waiting for baseline volume data...');
    } else {
      const top = ranked[0];
      const second = ranked[1];
      const msg = `${new Date().toISOString()} top ${top.pair} ${top.volumeVelocity.toFixed(2)}%/h` + (second ? ` second ${second.pair} ${second.volumeVelocity.toFixed(2)}%/h` : '');
      console.log(msg);
    }
  } catch (err) {
    console.error('Error fetching ticker', err);
  }
}

setInterval(check, interval);
check();
