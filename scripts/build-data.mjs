// Builds the block snapshot served to the browser:
//   public/data/base.bin.gz    blocks 0 … baseCount-1   (rebuilt only on a full build)
//   public/data/recent.bin.gz  blocks baseCount … tip   (small; refreshed by --update)
//   public/data/meta.json      counts, pool names, per-epoch difficulty
//
//   node scripts/build-data.mjs            full rebuild from data-cache/ (Blockchair dumps) + top-up from mempool.space
//   node scripts/build-data.mjs --update   keep base, append new blocks from mempool.space, rewrite recent + meta
//   node scripts/build-data.mjs --partial  test build from whatever contiguous prefix is downloaded
//
// Each .bin is little-endian struct-of-arrays, gzipped:
//   int32 timeDelta[n] (first entry absolute unix time) · uint16 txCount[n] · uint16 size100[n] (bytes/100)
//   uint32 feeK[n] (sats/1000) · uint8 pool[n] (index into meta.pools)
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const OUT = path.resolve('public/data');
const CACHE = path.resolve('data-cache');
const API = 'https://mempool.space/api';
const UPDATE = process.argv.includes('--update'), PARTIAL = process.argv.includes('--partial');
fs.mkdirSync(OUT, { recursive: true });

const key = s => (s || 'unknown').toLowerCase().replace(/pool|mining|\.com|\.org/g, '').replace(/[^a-z0-9]/g, '') || 'unknown';
const time = [], tx = [], size = [], fee = [], poolName = [], diff = [];
const set = (h, t, n, s, f, p, d) => { time[h] = t; tx[h] = n; size[h] = s; fee[h] = f; poolName[h] = p || 'Unknown'; if (d) diff[h] = d; };

function decode(file, from, pools) {
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  const n = raw.length / 13, buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length);
  let o = 0;
  const td = new Int32Array(buf, o, n); o += n * 4;
  const t16 = new Uint16Array(buf, o, n); o += n * 2;
  const s16 = new Uint16Array(buf, o, n); o += n * 2;
  const fk = new Uint32Array(buf, o, n); o += n * 4;
  const p8 = new Uint8Array(buf, o, n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += td[i]; set(from + i, acc, t16[i], s16[i] * 100, fk[i] * 1000, pools[p8[i]]); }
  return n;
}
function encode(a, b, pIdx) {
  const n = b - a, buf = Buffer.alloc(n * 13);
  let o = 0, prev = 0;
  for (let h = a; h < b; h++) { buf.writeInt32LE(time[h] - prev, o); prev = time[h]; o += 4; }
  for (let h = a; h < b; h++) { buf.writeUInt16LE(Math.min(65535, tx[h]), o); o += 2; }
  for (let h = a; h < b; h++) { buf.writeUInt16LE(Math.min(65535, Math.round(size[h] / 100)), o); o += 2; }
  for (let h = a; h < b; h++) { buf.writeUInt32LE(Math.min(4294967295, Math.round(fee[h] / 1000)), o); o += 4; }
  for (let h = a; h < b; h++) { buf.writeUInt8(pIdx(poolName[h]), o); o += 1; }
  return zlib.gzipSync(buf, { level: 9 });
}

let meta = null;
if (UPDATE) {
  meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'));
  const nb = decode(path.join(OUT, 'base.bin.gz'), 0, meta.pools);
  const nr = fs.existsSync(path.join(OUT, 'recent.bin.gz')) ? decode(path.join(OUT, 'recent.bin.gz'), nb, meta.pools) : 0;
  meta.epochDifficulty.forEach((d, e) => { diff[e * 2016] = d; });
  console.log(`snapshot: ${nb} base + ${nr} recent blocks`);
} else {
  const files = fs.readdirSync(CACHE).filter(f => f.endsWith('.tsv.gz')).sort();
  console.log(`parsing ${files.length} dump files…`);
  for (const f of files) {
    let text;
    try { text = zlib.gunzipSync(fs.readFileSync(path.join(CACHE, f))).toString('utf8'); } catch { console.warn('skip corrupt', f); continue; }
    const lines = text.split('\n'), head = lines[0].split('\t'), col = n => head.indexOf(n);
    const cId = col('id'), cT = col('time'), cS = col('size'), cN = col('transaction_count'), cF = col('fee_total'), cM = col('guessed_miner'), cD = col('difficulty');
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const c = lines[i].split('\t');
      set(+c[cId], Math.floor(Date.parse(c[cT].replace(' ', 'T') + 'Z') / 1000), +c[cN], +c[cS], +c[cF], c[cM], +c[cD]);
    }
  }
  if (PARTIAL) { let k = 0; while (time[k] !== undefined) k++; time.length = k; console.log(`partial build: ${k} blocks`); }
}

// top up from mempool.space; each request returns the 15 blocks ending at `top`
if (!PARTIAL) {
  const tip = +(await (await fetch(`${API}/blocks/tip/height`)).text());
  const want = new Set();
  for (let h = 0; h <= tip; h++) if (time[h] === undefined) want.add(h);
  console.log(`tip ${tip}, fetching ${want.size} blocks from mempool.space`);
  if (want.size > 30000) throw new Error('Too many blocks missing; run `npm run data:fetch` first.');
  for (const h of [...want].sort((a, b) => a - b)) {
    if (!want.has(h)) continue;
    for (let a = 0; a < 5; a++) {
      try {
        const r = await fetch(`${API}/v1/blocks/${Math.min(tip, h + 14)}`);
        if (r.status === 429) { await new Promise(s => setTimeout(s, 5000)); continue; }
        for (const b of await r.json()) if (want.delete(b.height)) set(b.height, b.timestamp, b.tx_count, b.size, b.extras?.totalFees ?? 0, b.extras?.pool?.name, b.difficulty);
        break;
      } catch { await new Promise(s => setTimeout(s, 2000)); }
    }
    await new Promise(s => setTimeout(s, 200));
  }
  if (want.size) console.warn(`still missing ${want.size} blocks, e.g. ${[...want].slice(0, 5)}`);
}

let n = time.length;
while (n > 0 && time[n - 1] === undefined) n--;
for (let h = 0; h < n; h++) if (time[h] === undefined) throw new Error(`gap at block ${h}`);

// pool table: full builds rank by block count; updates keep the existing order and append new names
let pools;
if (UPDATE) pools = meta.pools.slice();
else {
  const counts = new Map();
  for (let h = 0; h < n; h++) { const k = key(poolName[h]); if (k !== 'unknown') { const e = counts.get(k) || { n: 0, name: poolName[h] }; e.n++; counts.set(k, e); } }
  pools = ['Unknown', ...[...counts.values()].sort((a, b) => b.n - a.n).slice(0, 254).map(e => e.name)];
}
const pmap = new Map(pools.map((p, i) => [key(p), i]));
const pIdx = name => {
  const k = key(name);
  if (!pmap.has(k)) { if (pools.length >= 255) return 0; pools.push(name); pmap.set(k, pools.length - 1); }
  return pmap.get(k);
};

const baseCount = UPDATE ? meta.baseCount : n;
if (!UPDATE) fs.writeFileSync(path.join(OUT, 'base.bin.gz'), encode(0, baseCount, pIdx));
fs.writeFileSync(path.join(OUT, 'recent.bin.gz'), encode(baseCount, n, pIdx));

const epochDifficulty = [];
for (let e = 0; e * 2016 < n; e++) epochDifficulty.push(diff[e * 2016] ?? epochDifficulty[e - 1] ?? 1);
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ count: n, baseCount, built: new Date().toISOString(), tipTime: time[n - 1], pools, epochDifficulty }));
const sz = f => (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2);
console.log(`wrote ${n} blocks (tip #${n - 1}) · base ${sz('base.bin.gz')} MB · recent ${sz('recent.bin.gz')} MB · ${pools.length} pools`);
