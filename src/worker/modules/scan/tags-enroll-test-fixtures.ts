import { makeOrg, makeScanner, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { scannerActor, withRole } from './actor.ts';
import { createScannerStore } from './auth-store.ts';
import { clockedHub } from './clocked-hub-test-fixtures.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { liveAttachment } from './live.ts';
import { sealLiveAttachment } from './live-attachment.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { workspace } from './repo-session-activity-authority-test-fixtures.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { tagScanFixture } from './tags-scan-test-fixtures.ts';
import { grantScanMembership, ORIGIN, proofedScanActor } from './test-kit.ts';

const NFC_DEVICE = {
  width: 800,
  height: 1200,
  touch: true,
  camera: 'available',
  keyboard: false,
  nativeBarcode: true,
  native: {
    platform: 'android',
    appVersion: '1.0',
    camera: { available: true, permission: 'granted' },
    keyboard: { supported: true, connected: null, connectionObservable: false },
    nfc: { available: true, reading: true, formats: ['ndef', 'tag-uid'] },
    vas: { deviceSupported: false, available: false, reader: 'none', reason: '' },
    externalReader: { mode: 'unknown', connected: null },
    customerDisplay: { supported: false, available: false, active: false },
  },
  surfaces: ['operator'],
  preferred: 'operator',
};

/** Tags on, an org with a pass operator and a read-only user, another org, and scan-role devices that read tags. */
export async function enrollFixture() {
  const f = await tagScanFixture();
  const { kit } = f;
  // A hub alarm runs on the wall clock: a socket sealed against an older test clock would be closed at once.
  kit.clock.advance(Date.now() - kit.clock.now());
  const db = kit.env.DB;
  await ensureCredentialRefKeyset(db, kit.env);
  const app = createApp({
    clock: kit.clock,
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
  });

  async function member(orgId: string, roles: Parameters<typeof grantScanMembership>[3]) {
    const user = await makeUser(kit.fx);
    const membershipId = await grantScanMembership(kit.fx, orgId, user.id, roles);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
    return { user, membershipId, headers: session.headers };
  }
  const operator = await member(kit.org.id, ['pass_operator']);
  const reader = await member(kit.org.id, ['read_only']);
  const outsiderUser = await makeUser(kit.fx);
  const outsider = {
    user: outsiderUser,
    /** No membership: the shape of a member, for helpers that take either. */
    membershipId: '',
    headers: (await makeSession(kit.fx, { userId: outsiderUser.id, roles: ['user'] })).headers,
  };
  const other = await makeOrg(kit.fx);
  const stranger = await member(other.id, ['pass_operator']);
  await run(
    db,
    "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'nfc.tags', '{\"enabled\":true}', 1)",
    [`org:${other.id}`],
  );

  const nfc = (
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
    mode = 'live',
  ) =>
    app.request(
      `${ORIGIN}/api/v1/nfc${path}`,
      {
        method,
        headers: {
          ...headers,
          origin: ORIGIN,
          'x-passbook-mode': mode,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      kit.env,
    );

  /** A scan-role device in a session that reports tag reading, at a role. */
  async function device(role: 'door' | 'desk', over: { tags?: object; reads?: boolean } = {}) {
    const scanner = await kit.scanner({
      templateIds: [f.tpl],
      settings: { roleWithoutSignIn: role },
    });
    await workspace(
      kit,
      scanner,
      { templateIds: [f.tpl] },
      { ...DEFAULT_SETTINGS, roleWithoutSignIn: role, ...(over.tags ? { tags: over.tags } : {}) },
    );
    if (over.reads !== false)
      await run(db, 'UPDATE scanning_devices SET capabilities = ? WHERE scanner_id = ?', [
        JSON.stringify(NFC_DEVICE),
        scanner.id,
      ]);
    return scanner;
  }

  /** Opens the device socket of a scanner; the messages it gets are collected. */
  async function connect(id: string) {
    const row = await getScanner(db, id);
    if (!row) throw new Error('Missing scanner.');
    const scope = await readScannerScope(db, row, row.staffId);
    const actor = scannerActor(kit.ctx, row, row.mode, 'cookie', scope);
    await bindScanningSession(kit.ctx, actor);
    withRole(actor, null);
    const attachment = liveAttachment(kit.ctx, await proofedScanActor(kit.ctx, actor), 'device');
    const response = await clockedHub(kit.ctx, kit.clock, kit.org.id, 'live').fetch(
      new Request('https://hub.test', {
        headers: {
          upgrade: 'websocket',
          'x-pb-live': await sealLiveAttachment(kit.env, attachment),
        },
      }),
    );
    const socket = response.webSocket;
    if (response.status !== 101 || !socket)
      throw new Error(`The device did not connect: ${response.status}`);
    socket.accept();
    const messages: unknown[] = [];
    const closed: { code: number; reason: string }[] = [];
    socket.addEventListener('message', (e) => {
      messages.push(JSON.parse(String(e.data)));
    });
    socket.addEventListener('close', (e) => {
      closed.push({ code: e.code, reason: e.reason });
    });
    return { socket, messages, closed, attachment };
  }

  const hub = () => clockedHub(kit.ctx, kit.clock, kit.org.id, 'live');
  const wait = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
  const deviceGet = (s: { headers: Record<string, string> }, path: string) =>
    kit.get(s.headers, path);

  return {
    ...f,
    app,
    member,
    operator,
    reader,
    outsider,
    other,
    stranger,
    nfc,
    device,
    connect,
    hub,
    wait,
    deviceGet,
    otherScanner: () => makeScanner(kit.fx, { orgId: other.id }),
    json: async <T>(response: Response) => (await response.json()) as T,
  };
}

export type EnrollFixture = Awaited<ReturnType<typeof enrollFixture>>;
