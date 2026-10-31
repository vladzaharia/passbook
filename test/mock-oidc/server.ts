// Standalone mock Pocket ID for Playwright: node test/mock-oidc/server.ts [port]
import { createServer } from 'node:http';
import { createMockOidc } from './index.ts';

const port = Number(process.argv[2] ?? process.env.MOCK_OIDC_PORT ?? 5174);
const issuer = `http://localhost:${port}`;

const oidc = await createMockOidc({
  issuer,
  clientId: process.env.OIDC_CLIENT_ID ?? 'wallet-e2e',
  defaultUser: {
    sub: 'e2e-admin',
    email: 'admin@example.test',
    name: 'E2E Admin',
    groups: ['wallet-admins', 'wallet-users'],
  },
});
oidc.addUser({
  sub: 'e2e-admin',
  email: 'admin@example.test',
  name: 'E2E Admin',
  groups: ['wallet-admins', 'wallet-users'],
});
oidc.addUser({
  sub: 'e2e-user',
  email: 'user@example.test',
  name: 'E2E User',
  groups: ['wallet-users'],
});
oidc.addUser({ sub: 'e2e-nobody', email: 'nobody@example.test', name: 'No Groups', groups: [] });

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const response = await oidc.handle(
    new Request(`${issuer}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body,
      redirect: 'manual',
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`mock oidc on ${issuer}`));
