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
    groups: ['wallet_admins', 'wallet_users'],
  },
});
oidc.addUser({
  sub: 'e2e-admin',
  email: 'admin@example.test',
  name: 'E2E Admin',
  groups: ['wallet_admins', 'wallet_users'],
});
oidc.addUser({
  sub: 'e2e-user',
  email: 'user@example.test',
  name: 'E2E User',
  groups: ['wallet_users'],
});
oidc.addUser({
  sub: 'e2e-reviewer',
  email: 'reviewer@example.test',
  name: 'E2E Template Reviewer',
  groups: ['wallet_users'],
});
// Never granted a membership by any spec, so "no memberships" holds whatever else runs.
oidc.addUser({
  sub: 'e2e-loner',
  email: 'loner@example.test',
  name: 'E2E Loner',
  groups: ['wallet_users'],
});
// The developer quickstart's builder: makes the one sandbox a person gets, so no other spec signs in as them.
oidc.addUser({
  sub: 'e2e-builder',
  email: 'builder@example.test',
  name: 'E2E Builder',
  groups: ['wallet_users', 'passbook_developers'],
});
// The D12 onboarding journey's person: nothing else signs in as them, so their one sandbox is always fresh.
oidc.addUser({
  sub: 'e2e-onboard',
  email: 'onboard@example.test',
  name: 'E2E Onboard',
  groups: ['wallet_users', 'passbook_developers'],
});
// In the developer group but no organization: gets Developers and no Admin.
oidc.addUser({
  sub: 'e2e-developer',
  email: 'developer@example.test',
  name: 'E2E Developer',
  groups: ['wallet_users', 'passbook_developers'],
});
// The local demo owner (tools/seed-demo.ts): an org owner who signs in through Polaris ID.
oidc.addUser({
  sub: 'demo-owner',
  email: 'demo.owner@example.com',
  name: 'Demo Owner',
  groups: ['wallet_users'],
});
// The onboarding journey's invited admin (tools/dev/visual-journeys/onboarding-signin.ts).
oidc.addUser({
  sub: 'journey-admin',
  email: 'journey.admin@example.com',
  name: 'Journey Admin',
  groups: ['wallet_users'],
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
