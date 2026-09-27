// /b/:h → this function (see vercel.json). Crawlers read the preview tags; people are sent into the app.
export const config = { runtime: 'edge' };

export default function handler(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get('h') ?? '';
  const h = /^\d{1,7}$/.test(raw) ? +raw : null;
  const origin = url.origin;
  const label = h === null ? 'Find your block' : `Bitcoin block #${h.toLocaleString('en-US')}`;
  const title = `${label} · The Chain`;
  const desc = 'Every Bitcoin block ever mined, linked in one chain and growing live. Find the block you were born in.';
  const img = `${origin}/api/og${h === null ? '' : `?h=${h}`}`;
  const dest = h === null ? '/' : `/#${h}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="website"><meta property="og:url" content="${url.href}">
<meta property="og:title" content="${title}"><meta property="og:description" content="${desc}">
<meta property="og:image" content="${img}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}"><meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0;url=${dest}">
</head><body style="background:#04050A;color:#EEEAE2;font-family:system-ui"><script>location.replace(${JSON.stringify(dest)})</script>
<a href="${dest}" style="color:#F7931A">Open ${label}</a></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300, s-maxage=86400' } });
}
