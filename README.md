# The Chain

Every Bitcoin block ever mined, linked in one continuous chain in 3D, growing live.

- **Find your block**: pick your birthday (or the day you got your first bitcoin, or any day),
  fly back through the chain to the block mined that day, then share it on X, copy a link,
  or save a 6-second square video clip.
- **Live**: the translucent *next block* fills with waiting transactions from the mempool and
  crystallises onto the chain when a miner finds it, sending a shockwave down the chain.
- **Sound** (off by default): an ambient pad, a glassy tick for each incoming transaction,
  a boom and bell chord for each new block, a whoosh for long flights.
- **All history**: zoom out and the chain is one coil, 2009 at the centre and today at the edge,
  with a timeline, replay, and colouring by transactions, fees, size or miner.
- **Search**: block number, date (`2017-12-17`), block hash or transaction ID.
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
