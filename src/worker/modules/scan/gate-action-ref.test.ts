import { beforeAll, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';
import { scanById } from './repo-scans.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import { scanActionIdRef } from './scan-action-ref.ts';
import { sealScanEvent, verifyScanEventProvenance } from './scan-event-proof.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

it('keeps a private action ID out of signed event data and rejects forged references', async () => {
  const secret = 'private-wallet-action-id';
  const templateId = await kit.scanTemplate(
    'Opaque action identity',
    {
      actions: [{ id: secret, label: 'Check in', kind: 'check_in', repeat: 'always' }],
    },
    { passStyle: { userInfo: { internalAction: secret } } },
  );
  const pass = await kit.scanPass(templateId);
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const csrf = scanner.headers['x-csrf-token'];
  if (!csrf) throw new Error('Missing scanner CSRF fixture');
  const idempotencyKey = key();
  const request = () =>
    kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey,
      clientTs: kit.clock.now(),
      actionId: secret,
    });
  const real = kit.env.DB;
  let inspected = false;
  let leaked = false;
  let malformed = false;
  let csrfScalar = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (
            !sql.includes('INSERT INTO scan_gates') &&
            !(sql.includes('csrf_secret') && sql.includes('AS valid')) &&
            !sql.includes('AS authorized')
          )
            return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  if (sql.includes('INSERT INTO scan_gates')) inspected = true;
                  const slots = scanSecretSlots(sql, values.length);
                  if (!slots || values.length >= 100) malformed = true;
                  else
                    for (const [index, value] of values.entries()) {
                      if (typeof value !== 'string') continue;
                      if (value.includes(secret) && slots[index]?.label === null) leaked = true;
                      if (value.includes(csrf)) {
                        if (
                          value === csrf &&
                          (slots[index]?.label?.endsWith('csrf') ||
                            slots[index]?.label?.startsWith('csrf:'))
                        )
                          csrfScalar = true;
                        else leaked = true;
                      }
                    }
                  return statement.bind(...values);
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  const response = await (async () => {
    try {
      return await request();
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  })();
  expect(inspected).toBe(true);
  expect(malformed).toBe(false);
  expect(leaked).toBe(false);
  expect(csrfScalar).toBe(true);
  expect(response.status).toBe(200);
  const result = (await response.json()) as { kind: string; scanId: string | null };
  expect(result.kind).toBe('ok');
  if (!result.scanId) throw new Error('Missing committed scan');
  const event = await first<EventRow>(
    kit.env.DB,
    "SELECT * FROM pass_events WHERE pass_id=? AND json_extract(data,'$.scanId')=?",
    [pass.id, result.scanId],
  );
  const scan = await scanById(kit.env.DB, kit.org.id, result.scanId);
  if (!event || !scan) throw new Error('Missing committed evidence');
  expect(event.data).not.toContain(secret);
  const retention = await first<{ scan_id: string; ledger_event_id: string; pass_ref: string }>(
    kit.env.DB,
    'SELECT * FROM scan_retention_proofs WHERE scan_id=?',
    [result.scanId],
  );
  expect(retention).toMatchObject({ scan_id: result.scanId, ledger_event_id: event.id });
  expect(retention?.pass_ref).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(retention)).not.toContain(pass.id);
  expect(JSON.stringify(retention)).not.toContain(secret);
  const data = JSON.parse(event.data) as {
    actionIdRef: string;
    authority: {
      pinnedTemplateVersion: string;
      walletVersion: number;
      walletTemplateVersion: string | null;
      effect: { gateAfter: { actionIdRef: string } };
    };
  };
  const ref = await scanActionIdRef(kit.env, {
    orgId: pass.orgId,
    mode: pass.mode,
    templateId,
    actionId: secret,
  });
  expect(ref).toMatch(/^[0-9a-f]{64}$/);
  expect(data.actionIdRef).toBe(ref);
  expect(data.authority.effect.gateAfter.actionIdRef).toBe(ref);
  const reference = {
    ...scan,
    pinnedTemplateVersion: data.authority.pinnedTemplateVersion,
    walletVersion: data.authority.walletVersion,
    walletTemplateVersion: data.authority.walletTemplateVersion,
    direction: scan.direction ?? null,
    presenceScope: scan.presenceScope ?? null,
  };
  expect(await verifyScanEventProvenance(kit.env, event, reference)).toBe(true);
  expect(
    await verifyScanEventProvenance(kit.env, event, { ...reference, actionId: 'different-action' }),
  ).toBe(false);
  const cache = new Map<string, Promise<boolean>>();
  expect(await verifyScanEventProvenance(kit.env, event, reference, cache)).toBe(true);
  expect([...cache.keys()].join('')).not.toContain(secret);

  const envelope = JSON.parse(event.data) as Record<string, unknown> & {
    authority: Record<string, unknown> & {
      eventProof: {
        gateScope: string | null;
        scanAt: number;
        direction: 'in' | 'out' | null;
        presenceScope: string | null;
      };
    };
  };
  const { eventProof, ...unsignedAuthority } = envelope.authority;
  const effect = unsignedAuthority.effect as Record<string, unknown>;
  const gateAfter = effect.gateAfter as Record<string, unknown>;
  const projection = unsignedAuthority.eventProjection as {
    v: number;
    roles: Record<string, Record<string, unknown>>;
  };
  const role = Object.keys(projection.roles)[0];
  if (!role) throw new Error('Missing event projection role');
  const unsafe = [
    { ...envelope, authority: unsignedAuthority, rawSecret: 'PRIVATE-TOKEN' },
    { ...envelope, authority: { ...unsignedAuthority, csrfSecret: 'PRIVATE-CSRF' } },
    { ...envelope, authority: unsignedAuthority, reason: 'not_found' },
    { ...envelope, authority: { ...unsignedAuthority, scannerRevision: { raw: 'PRIVATE-CSRF' } } },
    {
      ...envelope,
      authority: {
        ...unsignedAuthority,
        effect: {
          ...effect,
          gateAfter: { ...gateAfter, holderEmail: 'private@example.test' },
        },
      },
    },
    {
      ...envelope,
      authority: {
        ...unsignedAuthority,
        eventProjection: {
          ...projection,
          roles: {
            ...projection.roles,
            [role]: { ...projection.roles[role], name: 'Private Name' },
          },
        },
      },
    },
  ];
  for (const body of unsafe) {
    const unsafeRow = { ...event, data: JSON.stringify(body) };
    await expect(
      sealScanEvent(
        kit.env,
        unsafeRow,
        eventProof.gateScope,
        eventProof.scanAt,
        eventProof.direction,
        eventProof.presenceScope,
      ),
    ).rejects.toThrow('Invalid scan event proof input');
    const forged = { ...body, authority: { ...body.authority, eventProof } };
    expect(
      await verifyScanEventProvenance(
        kit.env,
        { ...event, data: JSON.stringify(forged) },
        reference,
      ),
    ).toBe(false);
  }
  const eventWithSecret = { ...event, csrfSecret: 'PRIVATE-CSRF' };
  expect(await verifyScanEventProvenance(kit.env, eventWithSecret, reference)).toBe(false);

  const keys = Object.fromEntries(
    Object.entries(kit.env).filter(([name]) => /^KEK_V\d+$/.test(name)),
  ) as Record<string, string>;
  const changed = { ...keys };
  const unsigned = { ...envelope, authority: unsignedAuthority };
  const sealing = sealScanEvent(
    changed,
    { ...event, data: JSON.stringify(unsigned) },
    eventProof.gateScope,
    eventProof.scanAt,
    eventProof.direction,
    eventProof.presenceScope,
  );
  for (const name of Object.keys(changed)) changed[name] = btoa('x'.repeat(32));
  const resealed = await sealing;
  expect(await verifyScanEventProvenance(keys, resealed, reference)).toBe(true);
  expect(await verifyScanEventProvenance(changed, resealed, reference)).toBe(false);
  const checkingKeys = { ...keys };
  const checking = verifyScanEventProvenance(checkingKeys, event, reference);
  for (const name of Object.keys(checkingKeys)) checkingKeys[name] = btoa('x'.repeat(32));
  expect(await checking).toBe(true);

  const forgedGate = structuredClone(data);
  forgedGate.authority.effect.gateAfter.actionIdRef = '0'.repeat(64);
  expect(
    await verifyScanEventProvenance(
      kit.env,
      { ...event, data: JSON.stringify(forgedGate) },
      reference,
    ),
  ).toBe(false);
  const forgedRaw = { ...data, actionId: secret };
  expect(
    await verifyScanEventProvenance(
      kit.env,
      { ...event, data: JSON.stringify(forgedRaw) },
      reference,
    ),
  ).toBe(false);
  await run(kit.env.DB, 'UPDATE pass_events SET data=? WHERE id=?', [
    JSON.stringify(forgedRaw),
    event.id,
  ]);
  const replay = await request();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ kind: 'refused', reason: 'not_found' });
});
