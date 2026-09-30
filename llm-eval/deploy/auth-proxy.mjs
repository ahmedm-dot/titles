// Password gate for the self-hosted promptfoo UI on Render.
// promptfoo's server has no login of its own, so this process:
//   1. starts `promptfoo view` on an internal port (never exposed), and
//   2. serves $PORT, letting a request through only with the right HTTP Basic Auth.
// Browsers show a login prompt; `promptfoo share` sends the same credentials when
// PROMPTFOO_REMOTE_API_BASE_URL is https://USER:PASSWORD@your-app.onrender.com
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.PORT ?? 10000);
const INTERNAL_PORT = 15500;
const USER = process.env.BASIC_AUTH_USER ?? 'team';
const PASSWORD = process.env.BASIC_AUTH_PASSWORD ?? '';

if (PASSWORD.length < 12) {
  console.error('BASIC_AUTH_PASSWORD must be set and at least 12 characters. Refusing to start.');
  process.exit(1);
}
const expected = Buffer.from(`Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`);

function authorized(req) {
  const got = Buffer.from(req.headers.authorization ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const promptfoo = spawn('promptfoo', ['view', '-n', '-p', String(INTERNAL_PORT)], { stdio: 'inherit' });
promptfoo.on('exit', (code) => {
  console.error(`promptfoo exited (${code}); exiting so Render restarts the service`);
  process.exit(1);
});

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') return res.end('ok'); // Render health check, no data exposed
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="LLM eval", charset="UTF-8"' });
    return res.end('Authentication required');
  }
  const upstream = http.request(
    { host: '127.0.0.1', port: INTERNAL_PORT, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('promptfoo is starting, retry in a few seconds');
  });
  req.pipe(upstream);
});

// Live-update websocket used by the UI
server.on('upgrade', (req, socket, head) => {
  if (!authorized(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  const up = net.connect(INTERNAL_PORT, '127.0.0.1', () => {
    const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '0.0.0.0', () => console.log(`Auth proxy on :${PORT} -> promptfoo on :${INTERNAL_PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { promptfoo.kill(sig); process.exit(0); });
