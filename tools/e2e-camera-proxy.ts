import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Secure scanner cookies and camera permissions must be exercised on HTTPS in every engine.
const dir = mkdtempSync(join(tmpdir(), 'passbook-camera-tls-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-keyout',
    join(dir, 'key.pem'),
    '-out',
    join(dir, 'cert.pem'),
  ],
  { stdio: 'ignore' },
);
const server = createServer(
  { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
  (req, res) => {
    const upstream = request(
      {
        hostname: 'localhost',
        port: 5173,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: 'localhost:5173' },
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end('Test server unavailable');
    });
    req.pipe(upstream);
  },
);
server.listen(5175, 'localhost');
const stop = () => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
