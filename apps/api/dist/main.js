const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3010);
const ENGINE_URL = process.env.ENGINE_URL || 'http://127.0.0.1:8001';

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

function homeHtml() {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>NexoraDB API Gateway</title>
<style>
body{font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
.card{max-width:980px;margin:auto;background:#111827;border:1px solid #334155;border-radius:12px;padding:18px}
a{color:#93c5fd}
code{background:#1f2937;padding:2px 6px;border-radius:6px}
</style>
</head>
<body>
  <div class="card">
    <h1>NexoraDB API (modo preview)</h1>
    <p>Este servicio reemplaza temporalmente <code>dist/main.js</code> faltante.</p>
    <ul>
      <li>Engine URL: <code>${ENGINE_URL}</code></li>
      <li>Dashboard integrado: <a href="${ENGINE_URL}" target="_blank">Abrir Engine UI</a></li>
      <li>Swagger: <a href="${ENGINE_URL}/docs" target="_blank">${ENGINE_URL}/docs</a></li>
      <li>Proxy de health: <a href="/engine/" target="_blank">/engine/</a></li>
    </ul>
    <p>Tip: usa <code>npm start</code> en <code>apps/api</code> para arrancar este gateway.</p>
  </div>
</body>
</html>`;
}

function proxyToEngine(req, res) {
  const targetBase = new URL(ENGINE_URL);
  const incoming = new URL(req.url, `http://${req.headers.host}`);
  const proxiedPath = incoming.pathname.replace(/^\/engine/, '') || '/';
  const target = new URL(proxiedPath + incoming.search, targetBase);

  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: target.pathname + target.search,
    headers: { ...req.headers, host: target.host },
  };

  const client = (target.protocol === 'https:' ? require('https') : require('http')).request(options, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });

  client.on('error', (err) => {
    send(res, 502, `<h1>Error proxy</h1><pre>${String(err.message || err)}</pre>`);
  });

  req.pipe(client);
}

const server = http.createServer((req, res) => {
  const pathname = (new URL(req.url, `http://${req.headers.host}`)).pathname;

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'nexoradb-api-preview', engine: ENGINE_URL }));
    return;
  }

  if (pathname.startsWith('/engine')) {
    proxyToEngine(req, res);
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    send(res, 200, homeHtml());
    return;
  }

  send(res, 404, '<h1>404</h1><p>Ruta no encontrada.</p>');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[api-preview] running on http://127.0.0.1:${PORT}`);
  console.log(`[api-preview] engine proxy -> ${ENGINE_URL}`);
});
