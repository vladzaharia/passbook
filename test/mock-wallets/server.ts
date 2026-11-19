// Standalone fake Google Wallet + Samsung Wallet for dev and Playwright: node test/mock-wallets/server.ts [port]
// Control: GET /__mock/state, GET /__mock/requests, POST /__mock/reset, POST /__mock/inject {status, match?, times?}.
import { createServer } from 'node:http';
import { createMockWallets } from './index.ts';

const port = Number(process.argv[2] ?? process.env.MOCK_WALLETS_PORT ?? 5175);
const origin = `http://localhost:${port}`;
const wallets = createMockWallets();

createServer(async (req, res) => {
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
}).listen(port, () => process.stdout.write(`mock wallets on ${origin}\n`));
