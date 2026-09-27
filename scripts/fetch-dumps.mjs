// Downloads Blockchair's daily Bitcoin block dumps into data-cache/ (resumable).
import fs from 'fs';
import path from 'path';
const dir = path.resolve('data-cache');
fs.mkdirSync(dir, { recursive: true });
const index = await (await fetch('https://gz.blockchair.com/bitcoin/blocks/')).text();
const files = [...new Set(index.match(/blockchair_bitcoin_blocks_\d{8}\.tsv\.gz/g))].sort();
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const todo = files.filter(f => !fs.existsSync(path.join(dir, f)) || f.includes(today));
console.log(`${files.length} files, ${todo.length} to fetch`);
let done = 0, failed = [];
async function get(f) {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch('https://gz.blockchair.com/bitcoin/blocks/' + f);
      if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 3000 * (a + 1))); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(path.join(dir, f + '.part'), buf); fs.renameSync(path.join(dir, f + '.part'), path.join(dir, f));
      return;
    } catch (e) { await new Promise(s => setTimeout(s, 2000 * (a + 1))); }
  }
  failed.push(f);
}
const CONC = +(process.env.CONC || 4);
let i = 0;
await Promise.all([...Array(CONC)].map(async () => {
  while (i < todo.length) { const f = todo[i++]; await get(f); if (++done % 100 === 0) console.log(`${done}/${todo.length}`); }
}));
console.log('done; failed:', failed.length, failed.slice(0, 5).join(' '));
