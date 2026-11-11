// Dev only: seeds a demo dataset into a local dev server through the admin API.
//   SEED_BREAKGLASS_TOKEN=… node tools/seed-demo.ts [--url http://localhost:5173] [--token-file f]
// Token defaults to .secrets/breakglass-token (npm run breakglass). Refuses non-localhost URLs.
// Also makes a demo owner an org_admin in every org and pins uploaded templates to a release
// (tools/bootstrap-tenancy.ts --apply, local D1). Rerunnable: existing orgs, templates, passes (by external id), connections and keys are skipped.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { assertLocal, discPng, Session } from './lib/demo-client.ts';
import { demoPlans, emailOf, PORTAL } from './lib/demo-data.ts';
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
// Listing templates syncs the baked ones and Henry's org into a fresh database.
await admin.get('/api/v1/templates');

// Orgs
const ORGS = [
  { slug: 'northwind', name: 'Northwind Climbing', branding: { accent: '#2563eb' } },
  { slug: 'harbor-lights', name: 'Harbor Lights Festival', branding: { accent: '#d97706' } },
];
const orgs = await admin.all('/api/v1/orgs');
for (const org of ORGS) {
  if (!orgs.some((o) => o.slug === org.slug))
    orgs.push(await admin.send('POST', '/api/v1/orgs', org));
}
const orgId = (slug: string) => orgs.find((o) => o.slug === slug).id as string;
const henrys = orgId('henrys');
const northwind = orgId('northwind');
const harbor = orgId('harbor-lights');

// Templates: two baked ones assigned, a clone, an upload in flight and one failed import.
await admin.send('PATCH', '/api/v1/templates/baked:starter-store-card', { orgId: northwind });
await admin.send('PATCH', '/api/v1/templates/baked:starter-event-ticket', { orgId: harbor });
let templates = await admin.all('/api/v1/templates');
const byName = (name: string) => templates.find((t) => t.name === name);
if (!byName('Northwind Member')) {
  await admin.send('POST', '/api/v1/templates/baked:starter-generic/clone', {
    orgId: northwind,
    name: 'Northwind Member',
  });
}

function variantZip(name: string): Uint8Array {
  const dir = resolve(root, 'templates/starter-generic');
  const files: Record<string, Uint8Array> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    let bytes: Uint8Array = readFileSync(join(dir, entry.name));
    if (entry.name === 'wallet.template.json') {
      const manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
      manifest.name = name;
      // Uploads are untrusted: baked-only keywords and /semantics bindings are rejected.
      if (manifest.inputs?.properties?.website)
        manifest.inputs.properties.website.pattern = undefined;
      if (manifest.inputs) manifest.inputs.dependentRequired = undefined;
      manifest.bindings = (manifest.bindings ?? []).filter(
        (b: { to: { pointer?: string } }) => !b.to.pointer?.startsWith('/semantics'),
      );
      bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    }
    files[entry.name] = bytes;
  }
  return zipSync(files);
}
const upload = (query: string, zip: Uint8Array) =>
  admin.send('POST', `/api/v1/templates/uploads?${query}`, zip, {
    'content-type': 'application/zip',
  });
if (!byName('Harbor Crew Badge')) {
  await upload(`orgId=${harbor}&name=Harbor%20Crew%20Badge`, variantZip('Harbor Crew Badge'));
  await upload(
    `orgId=${harbor}&name=Broken%20Badge`,
    zipSync({ 'wallet.template.json': Buffer.from('{') }),
  );
}
templates = await admin.all('/api/v1/templates');
const member = byName('Northwind Member')?.id as string;

// Tenancy: a demo owner becomes org_admin everywhere and uploaded templates get a legacy release,
// without which passes cannot be issued. Writes the local D1 (.wrangler/state); safe to re-run.
if (!(await admin.all('/api/v1/users')).some((u) => u.primaryEmail === DEMO_OWNER))
  await new Session(base).magicLink(DEMO_OWNER, mailDir);
const tenancy = tenancyCommand(DEMO_OWNER);
execFileSync(tenancy.file, tenancy.args, { cwd: root, stdio: 'inherit' });

// Passes
const plans = demoPlans({ henrys, northwind, harbor, member });

const existing = new Set(
  (await admin.all('/api/v1/passes')).map((p) => p.externalId).filter(Boolean),
);
const IMAGE_SIZES: Record<string, [number, number]> = {
  'thumbnail@2x.png': [180, 180],
  'strip@2x.png': [750, 288],
};
let created = 0;
for (const [i, plan] of plans.entries()) {
  const externalId = `demo-${String(i + 1).padStart(3, '0')}`;
  if (existing.has(externalId)) continue;
  const pass = await admin.send(
    'POST',
    '/api/v1/passes',
    {
      orgId: plan.org,
      templateId: plan.template,
      input: plan.input,
      externalId,
      ...(plan.holder ? { holderEmail: plan.holder } : {}),
    },
    { 'idempotency-key': `seed-demo-${externalId}` },
  );
  created++;
  if (plan.image) {
    const [w, h] = IMAGE_SIZES[plan.image] ?? [180, 180];
    const png = discPng(w, h, [15, 118, 110], [240, 253, 250 - (i % 5) * 30]);
    await admin.send('PUT', `/api/v1/passes/${pass.id}/assets/${plan.image}`, png, {
      'content-type': 'image/png',
    });
  }
  if (i % 7 === 1) {
    // A second version for the history and diff views.
    await admin.send('PATCH', `/api/v1/passes/${pass.id}`, {
      input: {
        ...plan.input,
        ...('memberName' in plan.input
          ? { message: 'Pool closed Monday.' }
          : { note: 'Updated by staff.' }),
      },
    });
  }
  if (plan.void) await admin.send('POST', `/api/v1/passes/${pass.id}/void`);
}

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
const connections = await admin.all('/api/v1/connections');
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
    defaultTemplateId: 'baked:starter-event-ticket',
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
  const conn = await admin.send('POST', '/api/v1/connections', spec);
  if (spec.connectorType === 'demo') {
    await admin.send('POST', `/api/v1/connections/${conn.id}/test`);
    await admin.send('POST', `/api/v1/connections/${conn.id}/sync`);
  }
}

// API keys, one revoked.
const keys = (await admin.get('/api/v1/api-keys')).items as { name: string; id: string }[];
const KEYS = [
  { name: 'Henry’s CRM', orgId: henrys, scopes: ['passes:read', 'passes:write', 'holders:write'] },
  { name: 'Box office', orgId: harbor, scopes: ['passes:write'], expiresAt: Date.now() + 30 * DAY },
  { name: 'Ops read-only', orgId: null, scopes: ['passes:read', 'templates:read'] },
  { name: 'Old import script', orgId: northwind, scopes: ['passes:write'], revoke: true },
];
for (const { revoke, ...key } of KEYS) {
  if (keys.some((k) => k.name === key.name)) continue;
  const made = await admin.send('POST', '/api/v1/api-keys', key);
  if (revoke) await admin.send('DELETE', `/api/v1/api-keys/${made.id}`);
}

// One pass email for the delivery log (and a rendered email under the local mail directory).
const waiting = (await admin.all(`/api/v1/passes?orgId=${henrys}&holderState=waiting`))[0];
if (waiting) await admin.send('POST', `/api/v1/passes/${waiting.id}/resend-email`, {});

console.log(
  `Seeded ${base}: ${orgs.length} orgs, ${created} new passes, ${signedIn} portal users signed in.`,
);
