import { MINTABLE_SCOPES } from '../../src/shared/contracts/api-keys.ts';
import { SANDBOX_KEY_SCOPES } from '../../src/shared/contracts/developer-home.ts';
import { SANDBOX_TERMINAL_NAME } from '../../src/shared/copy/developer.ts';
import { BLUEPRINT_ID, EXAMPLE_IDS } from '../../src/web/developers/model/ids.ts';
import { createApp } from '../../src/worker/app.ts';
import { createApiKeyStore } from '../../src/worker/modules/api-keys/service.ts';
import { createSessionStore } from '../../src/worker/modules/auth/sessions.ts';
import { PLATFORM_IDENTITY_ID } from '../../src/worker/modules/identities/resolver.ts';
import {
  type BlueprintKit,
  blueprintKit,
} from '../../src/worker/modules/templates/blueprint-test-fixtures.ts';
import { denyAllStores } from '../../src/worker/platform/auth.ts';
import { run } from '../../src/worker/platform/db.ts';
import { sha256Hex } from '../../src/worker/platform/ids.ts';
import { runPassImport } from '../../src/worker/workflows/pass-import.ts';
import { createFakeIdp, installFakeIdp } from '../helpers/fake-idp.ts';
import { makeOrg, makeScanner } from './../helpers/index.ts';

const ORIGIN = 'https://passbook.mobile';
const SCOPES = [
  'org:read',
  'brand:manage',
  'templates:read',
  'templates:write',
  'templates:review',
  'templates:publish',
  'scanning:write',
  'scan-setup:read',
  'scan-setup:write',
  'passes:read',
  'passes:write',
  'messages:write',
  'holders:write',
  'connections:read',
  'connections:write',
  'webhooks:manage',
  'api-keys:write',
  'org:write',
  'audit:read',
  'scans:read',
  'scans:write',
  'nfc:read',
  'nfc:write',
];

/** A sandbox key holds no key minting, terminal scope or scanning setup (SANDBOX_KEY_SCOPES). */
const OVER_CEILING = new Set<string>(
  MINTABLE_SCOPES.filter((s) => !(SANDBOX_KEY_SCOPES as readonly string[]).includes(s)),
);

export interface Call {
  method: string;
  path: string;
  status: number;
  code?: string;
  detail?: string;
}

/**
 * A fresh organization with a Test key, a template made from a blueprint and released in Test, and a
 * pass. `fetch` answers like the Worker, with the example ids in the request swapped for these.
 */
let shared: Promise<BlueprintKit> | undefined;
type Instance = { id: string; params: Parameters<typeof runPassImport>[2]; done: boolean };
const instances: Instance[] = [];
const stepper = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    await (typeof a === 'function' ? (a as () => unknown) : (b as () => unknown))(),
} as unknown as Parameters<typeof runPassImport>[3];

/** Runs the import workflows a request started, as Workflows would after it answered. */
async function drainImports(env: BlueprintKit['env']) {
  for (const i of instances.filter((x) => !x.done)) {
    i.done = true;
    await runPassImport(env, i.id, i.params, stepper);
  }
}

/** The fixtures every world of this file shares: one database, the baked blueprints synced once. */
export const kit = () => {
  shared ??= blueprintKit().then((k) => {
    // The import workflow runs here, after the request that started it has answered (see `drainImports`).
    Object.assign(k.env, {
      PASS_IMPORT: {
        create: async (o: { id: string; params: Instance['params'] }) => {
          instances.push({ ...o, done: false });
          return { id: o.id };
        },
        get: async (id: string) => {
          const i = instances.find((x) => x.id === id);
          if (!i) throw new Error('instance.not_found');
          return { status: async () => ({ status: i.done ? 'complete' : 'running' }) };
        },
      },
    });
    return k;
  });
  return shared;
};

/** `kind: 'developer'` makes the organization a portal sandbox, which the capture endpoint needs. */
export async function snippetWorld(kit: BlueprintKit, options: { kind?: 'developer' } = {}) {
  const org = await makeOrg(kit.f, options);
  // The developer invitation snippet reaches Polaris ID through the provisioner binding, which a test env lacks.
  installFakeIdp(kit.env, createFakeIdp());
  // A role on the invitation pairs a console membership: the group Polaris ID reports must be the one sign-in reads.
  (kit.env as { OIDC_ADMIN_GROUP?: string }).OIDC_ADMIN_GROUP = 'passbook_console';
  const owner = await kit.member(org.id, ['org_admin']);
  const id = kit.f.ids.id();
  const prefix = kit.f.ids.token(6);
  const secret = `wlt_${prefix}_${kit.f.ids.token()}`;
  await run(
    kit.env.DB,
    `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_by, created_at)
     VALUES (?, ?, 'Snippets', ?, ?, ?, 'test', ?, ?)`,
    [
      id,
      org.id,
      prefix,
      await sha256Hex(secret),
      JSON.stringify(
        options.kind === 'developer' ? SCOPES.filter((s) => !OVER_CEILING.has(s)) : SCOPES,
      ),
      owner.userId,
      kit.clock.now(),
    ],
  );
  // The credential routes (pairing, token, staff, keysets) take only a live, org-bound key with a credential
  // scope and an expiry within 90 days, which a sandbox key can never be: they run through this one.
  const credentialPrefix = kit.f.ids.token(6);
  const credentialSecret = `wlt_${credentialPrefix}_${kit.f.ids.token()}`;
  // A developer sandbox org can hold no credential key (the sandbox ceiling), and its guides call none.
  if (options.kind !== 'developer')
    await run(
      kit.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_by, created_at, expires_at)
       VALUES (?, ?, 'Credential snippets', ?, ?, ?, 'live', ?, ?, ?)`,
      [
        kit.f.ids.id(),
        org.id,
        credentialPrefix,
        await sha256Hex(credentialSecret),
        JSON.stringify(['scanning:admin', 'nfc:keys', 'members:read', 'members:write']),
        owner.userId,
        kit.clock.now(),
        kit.clock.now() + 30 * 86_400_000,
      ],
    );
  const CREDENTIAL_PATH =
    /^\/api\/v1\/(?:scanners\/[^/]+\/(?:pairing|token)|scan-staff(?:\/.*)?|nfc\/keysets(?:\/.*)?|orgs\/[^/]+\/developer(?:-invitations|s)(?:\/.*)?)$/;
  const app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  const auth = { authorization: `Bearer ${secret}` };
  const send = (method: string, path: string, body?: unknown) =>
    app.request(
      `${ORIGIN}/api/v1${path}`,
      {
        method,
        headers: {
          ...auth,
          'content-type': 'application/json',
          'idempotency-key': kit.f.ids.token(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      kit.env,
    );
  const json = async (res: Response) => {
    if (!res.ok) throw new Error(`${res.url} ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, any>;
  };

  const used = await json(
    await send('POST', `/templates/${BLUEPRINT_ID}/use`, { orgId: org.id, name: 'Tickets' }),
  );
  const version = used.activeVersion ?? used.versions[0].version;
  const scope = { orgId: org.id, mode: 'test', provider: 'apple' };
  const candidate = await json(
    await send('POST', `/templates/${used.id}/candidates`, { ...scope, version }),
  );
  const approval = await json(
    await send('POST', `/templates/${used.id}/candidates/${candidate.id}/approve`, {
      ...scope,
      candidateHash: candidate.candidateHash,
      alone: true,
    }),
  );
  const release = await json(
    await send('POST', `/templates/${used.id}/releases`, {
      ...scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    }),
  );
  const pass = await json(
    await send('POST', '/passes', {
      orgId: org.id,
      templateId: used.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      mode: 'test',
      input: used.manifest.sample ?? {},
      holderEmail: 'ada@example.com',
      externalId: 'seed',
    }),
  );

  // A sandbox's own terminal (ensureSandboxTerminal makes it in the real flow); an ordinary org has none.
  const terminalId =
    options.kind === 'developer'
      ? (
          await makeScanner(kit.f, {
            orgId: org.id,
            mode: 'test',
            kind: 'terminal',
            templateIds: [used.id],
          })
        ).id
      : null;
  if (options.kind === 'developer')
    await run(
      kit.env.DB,
      'INSERT INTO developer_sandboxes (id, org_id, user_id, created_at, terminal_id) VALUES (?, ?, ?, ?, ?)',
      [kit.f.ids.id(), org.id, owner.userId, kit.clock.now(), terminalId],
    );
  if (terminalId)
    await run(kit.env.DB, 'UPDATE scanners SET name = ? WHERE id = ?', [
      SANDBOX_TERMINAL_NAME,
      terminalId,
    ]);

  const real: Record<string, string> = {
    [EXAMPLE_IDS.orgId]: org.id,
    [EXAMPLE_IDS.templateId]: used.id,
    [EXAMPLE_IDS.passId]: pass.id,
    [EXAMPLE_IDS.identityId]: PLATFORM_IDENTITY_ID,
  };
  // A rule anchors on a date input of the template, which a placeholder name is not.
  const swap = (text: string) =>
    text
      .replace(/0193a1b2-7c00-7000-8000-0000000000[a-e]1/g, (m) => real[m] ?? m)
      .replace(
        /("anchor"\s*:\s*\{\s*"kind"\s*:\s*"input"\s*,\s*"input"\s*:\s*)"Example"/g,
        '$1"startsAt"',
      );
  // The docs describe a gym's Day pass (tools/lib/example-world.ts: name, tier, validUntil); this world's template
  // is the event ticket, so a request's inputs become the ticket's own sample and its date input `startsAt`.
  const sample = (used.manifest.sample ?? {}) as Record<string, unknown>;
  const DOCS_INPUTS = new Set(['name', 'tier', 'validUntil']);
  const isDocsInput = (v: unknown): v is Record<string, unknown> =>
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).every((k) => DOCS_INPUTS.has(k));
  const adapt = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(adapt);
    if (!v || typeof v !== 'object') return v;
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, adapt(x)]));
    if (isDocsInput(o.input) && Object.keys(o.input).length) o.input = sample;
    if (isDocsInput(o.patch) && 'validUntil' in o.patch) o.patch = { startsAt: sample.startsAt };
    if (o.kind === 'input' && o.input === 'validUntil') o.input = 'startsAt';
    return o;
  };
  const adaptInputs = (text: string): string =>
    text.trimStart().startsWith('{') ? JSON.stringify(adapt(JSON.parse(text))) : text;
  const calls: Call[] = [];
  const fetchLike = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(swap(String(input instanceof Request ? input.url : input)));
    const body = typeof init.body === 'string' ? adaptInputs(swap(init.body)) : init.body;
    const headers = new Headers(init.headers);
    // The pairing poll is a read (`scan-setup:read`): the sandbox key keeps it.
    const poll = (init.method ?? 'GET') === 'GET' && url.pathname.endsWith('/pairing');
    if (CREDENTIAL_PATH.test(url.pathname) && !poll)
      headers.set('authorization', `Bearer ${credentialSecret}`);
    const res = await app.request(url.toString(), { ...init, headers, body }, kit.env);
    await drainImports(kit.env);
    const problem = res.ok
      ? {}
      : ((await res
          .clone()
          .json()
          .catch(() => ({}))) as { code?: string; detail?: string; issues?: unknown });
    calls.push({
      method: init.method ?? 'GET',
      path: url.pathname,
      status: res.status,
      code: problem.code,
      detail: problem.issues
        ? `${problem.detail} ${JSON.stringify(problem.issues)}`
        : problem.detail,
    });
    return res;
  };
  return {
    secret,
    orgId: org.id,
    templateId: used.id,
    passId: pass.id,
    terminalId,
    clock: kit.clock,
    calls,
    fetch: fetchLike as typeof fetch,
  };
}
