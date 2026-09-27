# The Chain

Every Bitcoin block ever mined, linked in one continuous chain in 3D, growing live.

- **Live**: the translucent *next block* fills with waiting transactions from the mempool and
  crystallises onto the chain when a miner finds it, sending a shockwave down the chain.
- **Click any block**: a compact card with its transactions, the BTC price that day, the miner,
  and any event that happened there. Arrow keys step along the chain.
- **Price**: every block carries the BTC/USD price of its day. It shows in the card, the live pill,
  the timeline (as a line over the activity bars) and as a colour mode.
- **32 events**: halvings, protocol upgrades, forks, bugs, exchange collapses, ETFs, El Salvador,
  price milestones and cycle peaks, marked with beams on the chain and ticks on the timeline.
  Edit the list in `src/main.ts` (`FIXED`); price milestones are computed from the price data.
- **All history**: zoom out and the chain is one coil, 2009 at the centre and today at the edge,
  with a timeline, replay, and colouring by transactions, fees, size, price or miner.
- **Search**: block number, date, event name, block hash or transaction ID.
- **Sound** (off by default): ambient pad, a tick per incoming transaction, a boom and bells per block.
- **Share links**: `/b/840000` opens that block and gives X/iMessage a preview image
  (`api/share.ts` + `api/og.ts`, Vercel edge functions).

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/
```

## Data

The browser loads a compact snapshot of per-block summaries (time, tx count, size,
fees, pool), about 13 bytes per block:

| file | contents |
|---|---|
| `public/data/base.bin.gz` | the full history at the last full build |
| `public/data/recent.bin.gz` | blocks since then (small, refreshed weekly) |
| `public/data/meta.json` | counts, pool names, difficulty per ring |
| `public/data/price.json` | daily BTC/USD since 2009 (blockchain.info) |

On load the page fetches any blocks newer than the snapshot from mempool.space
(up to ~4,000), then subscribes to its websocket for new blocks.

```bash
npm run data:update   # append new blocks + refresh prices (what the weekly GitHub Action runs)
npm run data:fetch    # download Blockchair's daily block dumps into data-cache/ (slow; resumable)
npm run data:build    # full rebuild of base + recent from data-cache/
```

Sources: [Blockchair database dumps](https://gz.blockchair.com/bitcoin/blocks/) for history
and the [mempool.space API](https://mempool.space/docs/api) for recent and live blocks.
Pool attribution for early blocks is mostly "Unknown": before pools existed, blocks were
mined by anonymous individuals.

## Deploy

Push to GitHub and import the repo in Vercel (framework preset: Vite). `vercel.json`
sets the build command and cache headers. The workflow in `.github/workflows/refresh-data.yml`
commits new blocks every Monday, which triggers a redeploy.

## Demo capture

`/?capture` turns off the real-time loop and exposes `window.__tick(dt)`, so a recorder can step
the app one video frame at a time. `../video/scripts/capture-demo.mjs` uses this to record the
product demo (needs `npm run dev` running and `npm i playwright-core` in `../video`).
