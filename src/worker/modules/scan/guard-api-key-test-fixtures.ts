import { fakeAuth, makeScanner } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createScannerStore } from './auth-store.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

export const ORIGIN = 'https://wallet.test';
export { key };

/** A kit whose app resolves real API keys, and a template with one action per role. */
export async function setupTillKit() {
  const kit: ScanKit = await setupScanKit();
  const fake = fakeAuth(ORIGIN);
  fake.bindSessions(kit.env.DB, kit.clock);
  const app = createApp({
    stores: {
      ...fake.stores,
      scanners: createScannerStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  const templateId = await kit.scanTemplate('Till', {
    actions: [
      { id: 'check_in', label: 'Check in', kind: 'check_in' },
      { id: 'deskact', label: 'Desk', kind: 'check_in', minRole: 'desk' },
      { id: 'vip', label: 'VIP', kind: 'check_in', minRole: 'manager' },
    ],
  });
  const call = (
    headers: Record<string, string>,
    path: string,
    body: unknown = {},
    method = 'POST',
  ) =>
    Promise.resolve(
      app.request(
        `${ORIGIN}/api/v1/scan${path}`,
        {
          method,
          headers: { ...headers, 'content-type': 'application/json' },
          ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
        },
        kit.env,
      ),
    );
  const read = (passId: string) => ({
    idempotencyKey: key(),
    input: { passId, method: 'manual' as const },
    clientTs: kit.clock.now(),
  });
  const request = (passId: string, over: Record<string, unknown> = {}) => ({
    ...read(passId),
    actionId: 'check_in',
    ...over,
  });

  /** A key row, written as the mint would: bound to `terminals` (none for a platform key). */
  async function mintKey(options: {
    orgId?: string | null;
    mode?: 'live' | 'test';
    scopes?: string[];
    terminals: readonly string[];
    expiresAt?: number | null;
  }) {
    const id = kit.fx.ids.id();
    const prefix = kit.fx.ids.token(6);
    const secret = `wlt_${prefix}_${kit.fx.ids.token()}`;
    await run(
      kit.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, expires_at)
       VALUES (?, ?, 'Till', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        options.orgId === undefined ? kit.org.id : options.orgId,
        prefix,
        await sha256Hex(secret),
        JSON.stringify(options.scopes ?? ['scans:write']),
        options.mode ?? 'live',
        kit.clock.now(),
        options.expiresAt ?? null,
      ],
    );
    for (const scannerId of options.terminals)
      await run(kit.env.DB, 'INSERT INTO api_key_terminals (key_id, scanner_id) VALUES (?, ?)', [
        id,
        scannerId,
      ]);
    return { id, secret, headers: { authorization: `Bearer ${secret}` } as Record<string, string> };
  }

  /** A terminal and a key bound to it. */
  async function till(
    options: {
      scopes?: string[];
      orgId?: string | null;
      mode?: 'live' | 'test';
      expiresAt?: number | null;
      terminal?: Parameters<typeof kit.scanner>[0];
    } = {},
  ) {
    const terminal = await kit.scanner({
      kind: 'terminal',
      templateIds: [templateId],
      settings: { flow: 'auto', letInAgain: 'anyone', roleWithoutSignIn: 'desk' },
      ...options.terminal,
    });
    const apiKey = await mintKey({
      ...options,
      terminals: options.orgId === null ? [] : [terminal.id],
    });
    const headers: Record<string, string> = {
      ...apiKey.headers,
      'x-passbook-device': terminal.id,
    };
    return { terminal, apiKey, headers };
  }
  const outcomeCode = async (res: Response) =>
    ((await res.clone().json()) as { code?: string }).code;
  const problemOf = async (res: Response) => {
    const { requestId: _requestId, ...rest } = (await res.json()) as Record<string, unknown>;
    return rest;
  };
  const makeTerminal = (options: Parameters<typeof makeScanner>[1]) => makeScanner(kit.fx, options);
  return {
    kit,
    app,
    /** Headers of a signed-in platform admin: the full OpenAPI document. */
    adminHeaders: fake.admin(),
    templateId,
    call,
    read,
    request,
    mintKey,
    till,
    outcomeCode,
    problemOf,
    makeTerminal,
  };
}
