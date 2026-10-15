import http from "node:http";

const port = 4173;
const page = (title, body, css = "", script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>html,body{margin:0;padding:0}*{box-sizing:border-box}body{font-family:"DejaVu Sans","Liberation Sans",sans-serif}${css}</style>
</head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

const staticPage = page(
  "Static fixture",
  '<main class="hero"><h1>Static Servo benchmark</h1><p>Deterministic HTML and CSS layout.</p><div class="badge">READY</div></main>',
  "body{background:#0f172a;color:#f8fafc}.hero{width:720px;margin:64px auto;padding:48px;background:#1e293b;border:4px solid #38bdf8;border-radius:18px}.badge{display:inline-block;padding:12px 24px;background:#22c55e;color:#052e16;font-weight:700}",
);

const javascriptPage = page(
  "JavaScript fixture",
  '<main id="app" class="state"><h1 id="title">Waiting</h1><div id="items"></div></main>',
  "body{background:#b91c1c;color:white}.state{height:240px;padding:48px}.item{display:inline-block;margin:8px;padding:12px;background:#dbeafe;color:#172554}",
  "document.body.style.background='#2563eb';document.querySelector('#title').textContent='JavaScript rendered';document.querySelector('#items').innerHTML=Array.from({length:8},(_,i)=>`<span class=\"item\">Item ${i+1}</span>`).join('');document.documentElement.dataset.js='complete';",
);

const heavyCards = Array.from({ length: 480 }, (_, index) => `<article class="card"><strong>Card ${index + 1}</strong><span>${(index * 17) % 101}</span></article>`).join("");
const heavyPage = page(
  "Heavy layout fixture",
  `<header><h1>Heavy CSS and DOM</h1></header><main class="grid">${heavyCards}</main>`,
  "body{background:#f1f5f9;color:#0f172a}header{padding:24px;background:#312e81;color:#eef2ff}.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:6px;padding:12px}.card{min-height:54px;padding:8px;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(135deg,#fff,#dbeafe);border:1px solid #94a3b8;box-shadow:0 1px 2px #64748b55}.card:nth-child(3n){transform:translateY(2px)}",
);

const mediaTiles = Array.from({ length: 18 }, (_, index) => `<figure><img src="/asset.svg?i=${index}" width="160" height="96"><figcaption>Asset ${index + 1}</figcaption></figure>`).join("");
const mediaPage = page(
  "Media fixture",
  `<header><h1>Images and installed fonts</h1></header><main>${mediaTiles}</main>`,
  "body{background:#fff7ed;color:#431407}header{padding:24px;font-family:" + '"Liberation Serif",serif' + "}main{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;padding:12px}figure{margin:0;padding:8px;background:white;border:2px solid #fdba74}img{display:block;width:100%;height:96px}figcaption{padding-top:6px;font-weight:bold}",
);

const longSections = Array.from({ length: 32 }, (_, index) => `<section style="background:hsl(${(index * 31) % 360} 70% 86%)"><h2>Section ${index + 1}</h2><p>Full-page deterministic content ${index + 1}</p></section>`).join("");
const longPage = page(
  "Long fixture",
  `<main>${longSections}</main>`,
  "section{height:220px;padding:42px 64px;border-bottom:2px solid #0f172a}h2{margin:0 0 16px;font-size:32px}",
);

const dynamicPage = page(
  "Dynamic fixture",
  '<main id="dynamic"><h1 id="dynamic-title">Pending update</h1><p id="dynamic-value">0</p></main>',
  "body{background:#991b1b;color:white}#dynamic{height:260px;padding:56px;transition:none}",
  "setTimeout(()=>{document.body.style.background='#16a34a';document.querySelector('#dynamic-title').textContent='Dynamic update complete';document.querySelector('#dynamic-value').textContent='42';document.documentElement.dataset.dynamic='complete'},250);",
);

const slowPage = page(
  "Slow resources fixture",
  '<link rel="stylesheet" href="/slow.css"><main><h1>Delayed resources</h1><img src="/slow.svg" width="320" height="180"><p id="slow-proof">COMPLETE</p></main>',
  "body{background:#fefce8;color:#422006}main{padding:48px}",
);

const responses = new Map([
  ["/static", staticPage],
  ["/javascript", javascriptPage],
  ["/heavy", heavyPage],
  ["/media", mediaPage],
  ["/long", longPage],
  ["/dynamic", dynamicPage],
  ["/slow", slowPage],
]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "fixture"}`);
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("ok");
    return;
  }
  if (url.pathname === "/asset.svg" || url.pathname === "/slow.svg") {
    const send = () => response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#0ea5e9"/><circle cx="80" cy="90" r="54" fill="#facc15"/><path d="M160 35h125v110H160z" fill="#7c3aed"/></svg>');
    if (url.pathname === "/slow.svg") setTimeout(send, 700); else send();
    return;
  }
  if (url.pathname === "/slow.css") {
    setTimeout(() => response.writeHead(200, { "content-type": "text/css", "cache-control": "no-store" }).end("main{border:8px solid #eab308}#slow-proof{font-size:28px;font-weight:700}"), 700);
    return;
  }
  if (url.pathname === "/failure") {
    setTimeout(() => request.socket.destroy(), 200);
    return;
  }
  if (url.pathname === "/timeout") {
    request.socket.setTimeout(30_000, () => request.socket.destroy());
    return;
  }
  const content = responses.get(url.pathname);
  if (!content) {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(content);
});

server.listen(port, "0.0.0.0", () => process.stdout.write(`fixture-ready:${port}\n`));

const close = () => server.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
