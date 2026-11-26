// Standalone fake Google Wallet + Samsung Wallet for dev and Playwright: node test/mock-wallets/server.ts [port]
// Control: GET /__mock/state, GET /__mock/requests, POST /__mock/reset, POST /__mock/inject {status, match?, times?},
// POST /__mock/samsung-template {cardId, template?}, POST /__mock/google-keys {keys} (the callback root keys served at /gp/m/issuer/keys).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMockWallets } from './index.ts';

const port = Number(process.argv[2] ?? process.env.MOCK_WALLETS_PORT ?? 5175);
const origin = `http://localhost:${port}`;
const wallets = createMockWallets();

createServer(async (req, res) => {
  try {
    await serve(req, res);
  } catch {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"mock failure"}');
  }
}).listen(port, '127.0.0.1', () => process.stdout.write(`mock wallets on ${origin}\n`));

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const response = await wallets.handle(
    new Request(`${origin}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      redirect: 'manual',
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
