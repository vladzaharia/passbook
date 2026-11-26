// Dev only: seeds a demo dataset into a local dev server through the admin API.
// Needs npm run dev:oidc (the owner signs in through the mock Polaris ID).
//   SEED_BREAKGLASS_TOKEN=… node tools/seed-demo.ts [--url http://localhost:5173] [--token-file f]
// Token defaults to .secrets/breakglass-token (npm run breakglass). Refuses non-localhost URLs.
// Also makes a demo owner an org_admin in every org and pins uploaded templates to a release
// (tools/bootstrap-tenancy.ts --apply, local D1). Rerunnable: existing orgs, templates, passes (by external id), connections and keys are skipped.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { assertLocal, discPng, Session } from './lib/demo-client.ts';
import { demoPlans, emailOf, PORTAL } from './lib/demo-data.ts';
import { seedExtras } from './lib/demo-extras.ts';
import { releaseTemplates } from './lib/demo-releases.ts';
import { DEMO_OWNER, tenancyCommand } from './lib/demo-tenancy.ts';

const root = resolve(import.meta.dirname, '..');
const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const base = assertLocal(arg('--url') ?? 'http://localhost:5173');
const tokenFile = resolve(root, arg('--token-file') ?? '.secrets/breakglass-token');
const token =
  process.env.SEED_BREAKGLASS_TOKEN ??
  (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
if (!token) throw new Error('Set SEED_BREAKGLASS_TOKEN or run npm run breakglass first.');
const mailDir = resolve(root, '.wrangler/tmp/email');

const DAY = 86_400_000;

const admin = new Session(base);
await admin.breakglass(token);
// Listing templates syncs the baked ones and Henry's org into a fresh database; the sync is lazy and
// skips for a while after a contended attempt, so poll before using blueprints.
async function waitForBlueprints(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const list = await admin.all('/api/v1/templates?blueprint=true');
    if (list.some((t) => t.id === 'baked:starter-store-card')) return;
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error(
    'Baked blueprints never appeared. Check the dev server log for templates.baked_synced, or run the cron: curl "<url>/cdn-cgi/handler/scheduled?cron=*+*+*+*+*".',
  );
}
await waitForBlueprints();

// Orgs
const ORGS = [
  { slug: 'northwind', name: 'Northwind Climbing', branding: { accent: '#2563eb' } },
  { slug: 'harbor-lights', name: 'Harbor Lights Festival', branding: { accent: '#d97706' } },
];
const orgs = await admin.all('/api/v1/orgs');
for (const org of ORGS) {
  if (!orgs.some((o) => o.slug === org.slug))
    // addMe false: the break-glass account is not a member, so the demo owner stays each org's only reviewer.
    orgs.push(await admin.send('POST', '/api/v1/orgs', { ...org, preset: 'legacy', addMe: false }));
}
const orgId = (slug: string) => orgs.find((o) => o.slug === slug).id as string;
const henrys = orgId('henrys');
const northwind = orgId('northwind');
const harbor = orgId('harbor-lights');

// A platform admin without membership is treated as a non-member (404), so the demo owner makes the
// org templates: sign in once, then become org_admin in every org (re-run after uploads below).
const owner = new Session(base);
// Admin and developer access is Polaris ID only, so the owner signs in through the local mock
// provider (npm run dev:oidc). The mock verifies its emails; trusting them lets a first sign-in
// create the account without a mail round trip, as in the e2e database.
await admin.send('PUT', '/api/v1/settings', {
  scope: 'platform',
  values: { 'oidc.trustEmail': true },
});
await owner.oidc('demo-owner');
const tenancy = tenancyCommand(DEMO_OWNER);
const applyTenancy = () =>
  execFileSync(tenancy.file, tenancy.args, { cwd: root, stdio: 'inherit' });
applyTenancy();

// Templates: made from blueprints (passes come from templates), an upload in flight and one failed import.
// A platform admin's list shows platform templates only; org templates come per org.
const listTemplates = async () =>
  (await Promise.all(orgs.map((o) => owner.all(`/api/v1/templates?orgId=${o.id}`)))).flat();
let templates = await listTemplates();
const byName = (name: string) => templates.find((t) => t.name === name);
async function fromBlueprint(slug: string, orgId: string, name: string): Promise<string> {
  const found = byName(name);
  if (found) return found.id as string;
  const made = await owner.send('POST', `/api/v1/templates/baked:starter-${slug}/use`, {
    orgId,
    name,
  });
  return made.id as string;
}
const store = await fromBlueprint('store-card', northwind, 'Northwind Store Card');
const ticket = await fromBlueprint('event-ticket', harbor, 'Harbor Event Ticket');
const coupon = await fromBlueprint('coupon', northwind, 'Northwind Coupon');
const crew = await fromBlueprint('generic', harbor, 'Harbor Crew');
await fromBlueprint('generic', northwind, 'Northwind Member');

function variantZip(name: string, joinable = false): Uint8Array {
  const dir = resolve(root, 'templates/starter-generic');
  const files: Record<string, Uint8Array> = {};
  // Nested files (wallets/google/logo.png) belong to the package: an upload without them is invalid.
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const rel = relative(dir, join(entry.parentPath, entry.name));
    let bytes: Uint8Array = readFileSync(join(dir, rel));
    if (rel === 'wallet.template.json') {
      const manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
      manifest.name = name;
      // An uploaded package is never a blueprint.
      manifest.blueprint = undefined;
      // Uploads are untrusted: baked-only keywords and /semantics bindings are rejected.
      if (manifest.inputs?.properties?.website)
        manifest.inputs.properties.website.pattern = undefined;
      if (manifest.inputs) manifest.inputs.dependentRequired = undefined;
      manifest.bindings = (manifest.bindings ?? []).filter(
        (b: { to: { pointer?: string } }) => !b.to.pointer?.startsWith('/semantics'),
      );
      // A join link needs a barcode that carries only the scan code, so its alt text names no input.
      if (joinable)
        for (const b of manifest.bindings)
          if (b.to.barcode === '*' && b.to.prop === 'altText') b.value = 'Member code';
      bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    }
    files[rel] = bytes;
  }
  return zipSync(files);
}
const upload = (query: string, zip: Uint8Array) =>
  owner.send('POST', `/api/v1/templates/uploads?${query}`, zip, {
    'content-type': 'application/zip',
  });
if (!byName('Harbor Join Badge'))
  await upload(`orgId=${harbor}&name=Harbor%20Join%20Badge`, variantZip('Harbor Join Badge', true));
if (!byName('Harbor Crew Badge')) {
  await upload(`orgId=${harbor}&name=Harbor%20Crew%20Badge`, variantZip('Harbor Crew Badge'));
  await upload(
    `orgId=${harbor}&name=Broken%20Badge`,
    zipSync({ 'wallet.template.json': Buffer.from('{') }),
  );
}
// An upload imports asynchronously; its template appears when the build is done.
for (let attempt = 0; attempt < 60; attempt++) {
  templates = await listTemplates();
  if (byName('Harbor Join Badge') && byName('Harbor Crew Badge')) break;
  await new Promise((done) => setTimeout(done, 1000));
}
const member = byName('Northwind Member')?.id as string;

// Tenancy: the demo owner is org_admin everywhere. Passes issue only from a live release, so the
// owner approves and publishes each org template. Safe to re-run.
applyTenancy();
await releaseTemplates(owner, templates);

// Passes
const plans = demoPlans({ henrys, northwind, harbor, member, store, ticket, coupon, crew });

const existing = new Set(
  (await Promise.all(orgs.map((o) => owner.all(`/api/v1/passes?orgId=${o.id}`))))
    .flat()
    .map((p) => p.externalId)
    .filter(Boolean),
);
const IMAGE_SIZES: Record<string, [number, number]> = {
  'thumbnail@2x.png': [180, 180],
  'strip@2x.png': [750, 288],
};
let created = 0;
// A session issues passes only after a reviewed release; an API key issues from the scope's approved
// release, so each org gets a short-lived key for the run.
const api = new Session(base);
const issuers = new Map<string, { secret: string; id: string }>();
async function issuer(org: string) {
  if (!issuers.has(org)) {
    const key = await owner.send('POST', '/api/v1/api-keys', {
      name: 'Demo issuer',
      orgId: org,
      scopes: ['passes:read', 'passes:write'],
      // Revoked at the end of the run; the expiry covers a run that crashes first.
      expiresAt: Date.now() + 3_600_000,
    });
    issuers.set(org, { secret: key.secret, id: key.id });
  }
  return { authorization: `Bearer ${issuers.get(org)?.secret}` };
}
for (const [i, plan] of plans.entries()) {
  const externalId = `demo-${String(i + 1).padStart(3, '0')}`;
  if (existing.has(externalId)) continue;
  const auth = await issuer(plan.org);
  const pass = await api.send(
    'POST',
    '/api/v1/passes',
    {
      orgId: plan.org,
      templateId: plan.template,
      input: plan.input,
      externalId,
      ...(plan.holder ? { holderEmail: plan.holder } : {}),
    },
    { ...auth, 'idempotency-key': `seed-demo-${externalId}` },
  );
  created++;
  if (plan.image) {
    const [w, h] = IMAGE_SIZES[plan.image] ?? [180, 180];
    const png = discPng(w, h, [15, 118, 110], [240, 253, 250 - (i % 5) * 30]);
    await api.send('PUT', `/api/v1/passes/${pass.id}/assets/${plan.image}`, png, {
      ...auth,
      'content-type': 'image/png',
    });
  }
  if (i % 7 === 1) {
    // A second version for the history and diff views.
    await api.send(
      'PATCH',
      `/api/v1/passes/${pass.id}`,
      {
        input: {
          ...plan.input,
          ...('memberName' in plan.input
            ? { message: 'Pool closed Monday.' }
            : { note: 'Updated by staff.' }),
        },
      },
      auth,
    );
  }
  if (plan.void) await api.send('POST', `/api/v1/passes/${pass.id}/void`, undefined, auth);
}
for (const [org, { id }] of issuers)
  await owner.send('DELETE', `/api/v1/api-keys/${id}?orgId=${org}`);

// Portal users: a magic-link sign-in creates the user and attaches their waiting passes.
const users = await admin.all('/api/v1/users');
let signedIn = 0;
for (const name of PORTAL) {
  const email = emailOf(name);
  if (users.some((u) => u.primaryEmail === email)) continue;
  try {
    await new Session(base).magicLink(email, mailDir);
    signedIn++;
  } catch (error) {
    console.warn(`Portal user ${email} skipped: ${(error as Error).message}`);
  }
}
const theo = (await admin.all('/api/v1/users')).find(
  (u) => u.primaryEmail === emailOf('Theo Laurent'),
);
if (theo && theo.status === 'active')
  await admin.send('PATCH', `/api/v1/users/${theo.id}`, { status: 'disabled' });

// Connections: one healthy demo sync, one failing upstream, one webhook that never ran.
const connections = (
  await Promise.all(orgs.map((o) => owner.all(`/api/v1/connections?orgId=${o.id}`)))
).flat();
const CONNECTIONS = [
  {
    orgId: northwind,
    connectorType: 'demo',
    name: 'Member sync',
    config: { seed: 'northwind', count: 6, holderDomain: 'members.northwind.example' },
    defaultTemplateId: member,
    mapping: {
      holder: { from: '/memberName' },
      memberId: { from: '/memberId' },
      points: { from: '/points' },
    },
    holderEmailField: '/email',
    autoCreate: true,
  },
  {
    orgId: harbor,
    connectorType: 'demo',
    name: 'Box office feed',
    config: { seed: 'harbor', count: 5, fail: 'upstream' },
    defaultTemplateId: ticket,
    mapping: { attendee: { from: '/memberName' }, ticketId: { from: '/memberId' } },
  },
  {
    orgId: henrys,
    connectorType: 'webhook-push',
    name: 'Front desk',
    config: {},
    defaultTemplateId: 'baked:henrys-blue',
    mapping: {
      memberName: { from: '/name' },
      memberId: { from: '/id' },
      membership: { from: '/plan' },
    },
  },
];
for (const spec of CONNECTIONS) {
  if (connections.some((c) => c.name === spec.name && c.orgId === spec.orgId)) continue;
  const conn = await owner.send('POST', '/api/v1/connections', spec);
  if (spec.connectorType === 'demo') {
    await owner.send('POST', `/api/v1/connections/${conn.id}/test`);
    await owner.send('POST', `/api/v1/connections/${conn.id}/sync`);
  }
}

// API keys, one revoked.
const keys = (
  await Promise.all([
    ...orgs.map((o) => owner.all(`/api/v1/api-keys?orgId=${o.id}`)),
    admin.all('/api/v1/api-keys?orgId=null'),
  ])
).flat() as { name: string; id: string }[];
const KEYS = [
  { name: 'Henry’s CRM', orgId: henrys, scopes: ['passes:read', 'passes:write', 'holders:write'] },
  { name: 'Box office', orgId: harbor, scopes: ['passes:write'], expiresAt: Date.now() + 30 * DAY },
  {
    // A platform key needs an expiry and an IP allowlist.
    name: 'Ops read-only',
    orgId: null,
    scopes: ['passes:read', 'templates:read'],
    expiresAt: Date.now() + 7 * DAY,
    ipAllow: ['127.0.0.1/32', '::1/128'],
  },
  { name: 'Old import script', orgId: northwind, scopes: ['passes:write'], revoke: true },
];
for (const { revoke, ...key } of KEYS) {
  if (keys.some((k) => k.name === key.name)) continue;
  // Org keys are the owner's to manage; a platform admin is not a member.
  const who = key.orgId ? owner : admin;
  const made = await who.send('POST', '/api/v1/api-keys', key);
  if (revoke) await who.send('DELETE', `/api/v1/api-keys/${made.id}?orgId=${key.orgId}`);
}

// One pass email for the delivery log (and a rendered email under the local mail directory).
const waiting = (await owner.all(`/api/v1/passes?orgId=${henrys}&holderState=waiting`))[0];
if (waiting) await owner.send('POST', `/api/v1/passes/${waiting.id}/resend-email`, {});

await seedExtras(owner, { northwind, harbor, henrys, member, crew }, base);

console.log(
  `Seeded ${base}: ${orgs.length} orgs, ${created} new passes, ${signedIn} portal users signed in.`,
);
