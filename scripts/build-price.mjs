// Daily BTC/USD since the genesis block → public/data/price.json  ({ start: 'YYYY-MM-DD', usd: number[] }, one value per UTC day)
// Source: blockchain.info market-price chart (zeros before the first market trade in Aug 2010).
import fs from 'fs';
const r = await fetch('https://api.blockchain.info/charts/market-price?timespan=all&format=json&sampled=false');
if (!r.ok) throw new Error(`price fetch failed: ${r.status}`);
const { values } = await r.json();
const day = t => Math.floor(t / 86400);
const d0 = day(values[0].x), usd = [];
for (const { x, y } of values) usd[day(x) - d0] = y >= 10 ? Math.round(y) : Math.round(y * 100) / 100;
for (let i = 0; i < usd.length; i++) if (usd[i] === undefined) usd[i] = usd[i - 1] ?? 0;   // fill any gaps
const start = new Date(d0 * 86400e3).toISOString().slice(0, 10);
fs.writeFileSync('public/data/price.json', JSON.stringify({ start, usd }));
console.log(`price.json: ${usd.length} days from ${start}, latest $${usd[usd.length - 1]}`);
