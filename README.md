# Chain Rings

Every Bitcoin block ever mined, laid out as tree rings in 3D. Each ring is one
difficulty period (2,016 blocks, about two weeks); the genesis block sits at the
centre and new blocks land on the outer edge live.

- **Colour & height**: transactions, fees, size, time between blocks, or mining pool
- **Timeline**: scrub or replay 2009 → today, with landmark blocks marked
- **Search**: block height, date (`2017-12-17`), block hash or transaction ID
- **Block detail**: live data from mempool.space, plus a cloud of its transactions
- **Deep links**: `/#840000` opens that block

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

On load the page fetches any blocks newer than the snapshot from mempool.space
(up to ~4,000), then subscribes to its websocket for new blocks.

```bash
npm run data:update   # append new blocks from mempool.space (what the weekly GitHub Action runs)
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
