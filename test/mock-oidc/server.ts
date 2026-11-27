// Standalone mock Pocket ID for Playwright: node test/mock-oidc/server.ts [port]
import { createServer } from 'node:http';
import { createMockPolaris } from './admin-api.ts';
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
oidc.addUser({ sub: 'e2e-nobody', email: 'nobody@example.test', name: 'No Groups', groups: [] });

// Polaris ID's admin API and controls (admin-api.ts) share this server; the binding's key and the SCIM bearer are the run's own.
const polaris = createMockPolaris({
  oidc,
  apiKey: process.env.E2E_POLARIS_KEY ?? 'e2e-polaris-key',
  appOrigin: process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
  scimToken: process.env.SCIM_BEARER_TOKEN ?? '',
});

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  // A journey run invites its own admin, journey.admin+<run>@example.com, and signs in as `journey-admin+<run>`.
  const hint = new URL(req.url ?? '/', issuer).searchParams.get('login_hint');
  const run = /^journey-admin\+([a-z0-9]{1,24})$/.exec(hint ?? '')?.[1];
  if (run)
    oidc.addUser({
      sub: hint as string,
      email: `journey.admin+${run}@example.com`,
      name: 'Journey Admin',
      groups: ['wallet_users'],
    });
  const request = new Request(`${issuer}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body,
    redirect: 'manual',
  });
  const response = (await polaris.handle(request.clone())) ?? (await oidc.handle(request));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`mock oidc on ${issuer}`));
