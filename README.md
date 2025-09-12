# Kraken Volume Monitor

Monitors multiple Kraken trading pairs for 24h volume vs price change divergence and ranks them by volume velocity. Alerts are posted to Slack when the divergence crosses a threshold.

## Setup
1. Copy `.env.example` to `.env` and fill in values.
2. `npm install`
3. `npm start`

### Environment Variables
- `KRAKEN_PAIRS` – comma-separated list of trading pairs to monitor (default `XXBTZUSD,SOLUSD`).
- `QUOTE` – quote currency for your safety assets (e.g., `USD`).
- `SAFEGUARD_PAIR` – primary safety pair to rotate into when volume drops (e.g., `SOLUSD`).
- `FALLBACK_PAIR` – secondary safety pair if the safeguard pair fails (e.g., `XBTUSD`).
- `SLACK_WEBHOOK_URL` – Slack Incoming Webhook URL.
- `POLL_INTERVAL_MS` – polling interval in ms (default `30000`).
- `KRAKEN_API_KEY`, `KRAKEN_API_SECRET` – optional credentials for future trading automation; the monitor only uses public data and does not require them.

## Persistent Hosting
The script runs continuously, so deploy it on a persistent host (VM, container service, etc.). Vercel's serverless functions time out after ~10s and cron triggers at most once per minute, which is insufficient for sub-minute polling.

## Testing
```
npm test
```
Tests cover pure calculation helpers and do not touch real funds, so the script effectively operates in "paper" mode.
