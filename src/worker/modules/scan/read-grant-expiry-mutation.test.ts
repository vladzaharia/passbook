import { describe, expect, it, vi } from 'vitest';
import type { ScanInput } from '../../../shared/contracts/scan.ts';
import { createLogger } from '../../platform/log.ts';
import { scannerActor, withRole } from './actor.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import {
  kit,
  registerLookupOutputFixture,
  scannerForLookup,
  templateId,
} from './lookup-output-test-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { evaluate } from './resolve-evaluate.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { key, proofedScanActor } from './test-kit.ts';

registerLookupOutputFixture();

// The Worker targets ES2023; its test runtime provides Promise.withResolvers.
const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};

/** Pause the real WebCrypto operation after its input has been selected, never replacing its result. */
async function pauseCrypto<T>(
  kind: 'sign' | 'digest',
  match: string,
  work: () => Promise<T>,
  mutate: () => void,
): Promise<T> {
  const entered = deferred.withResolvers<void>();
  const release = deferred.withResolvers<void>();
  let triggered = false;
  const pause = async (data: BufferSource) => {
    if (!triggered && new TextDecoder().decode(data) === match) {
      triggered = true;
      entered.resolve();
      await release.promise;
    }
  };
  let restore: () => void;
  if (kind === 'sign') {
    const native = crypto.subtle.sign.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (algorithm, key, data) => {
      await pause(data);
      return native(algorithm, key, data);
    });
    restore = () => spy.mockRestore();
  } else {
    const native = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      await pause(data);
      return native(algorithm, data);
    });
    restore = () => spy.mockRestore();
  }
  const pending = work();
  try {
    await Promise.race([
      entered.promise,
      pending.then(
        () => {
          throw new Error('The selected crypto operation was not reached');
        },
        (error: unknown) => {
          throw error;
        },
      ),
    ]);
    mutate();
    release.resolve();
    const result = await pending;
    expect(triggered).toBe(true);
    return result;
  } finally {
    release.resolve();
    restore();
  }
}

const KEYSET_FRAME = 'pass-credential-ref-keyset-v1';

async function passes() {
  const original = await kit.scanPass(templateId, { memberName: 'Original Snapshot Member' });
  const other = await kit.scanPass(templateId, { memberName: 'Substitute Snapshot Member' });
  if (!original.scanCode || !other.scanCode) throw new Error('Missing fixture credentials');
  return { original, other, originalCode: original.scanCode, otherCode: other.scanCode };
}

describe('read credential input capture', () => {
  it('resolves the original request and actor after their caller mutates them during keyset HMAC', async () => {
    const { original, originalCode } = await passes();
    const alternateTemplate = await kit.scanTemplate('Alternate snapshot scope', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    });
    const alternate = await kit.scanPass(alternateTemplate, { memberName: 'Wrong Scope Member' });
    if (!alternate.scanCode) throw new Error('Missing alternate credential');
    const { actor } = await scannerForLookup();
    const expected = await credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', {
      code: originalCode,
      method: 'camera',
    });
    const scope = { orgId: kit.org.id, templateIds: [templateId], timeZone: 'UTC' };
    const input = { code: originalCode, method: 'camera' as const };
    const req: { idempotencyKey: string; input: ScanInput; clientTs: number; scope: typeof scope } =
      { idempotencyKey: key(), input, clientTs: kit.clock.now(), scope };
    const logs: string[] = [];
    const log = createLogger(
      {},
      {
        level: 'debug',
        sink: (line) => {
          logs.push(line);
        },
      },
    );
    const ctx = { ...kit.ctx, log };
    const result = await pauseCrypto(
      'sign',
      KEYSET_FRAME,
      () => resolveOutcome(ctx, actor, req),
      () => {
        input.code = alternate.scanCode!;
        req.input = { passId: alternate.id, method: 'manual' };
        scope.templateIds[0] = alternateTemplate;
        actor.templateIds[0] = alternateTemplate;
      },
    );
    expect(result.outcome).toMatchObject({ kind: 'ready', card: { passId: original.id } });
    expect(result.evaluatedSnapshot?.pass.id).toBe(original.id);
    expect(result.credentialContext).toEqual(expected);
    const response = JSON.stringify(result.outcome);
    expect(response).not.toContain(alternate.id);
    expect(response).not.toContain('Wrong Scope Member');
    for (const secret of [
      originalCode,
      alternate.scanCode,
      original.serial,
      alternate.serial,
      original.authToken,
      alternate.authToken,
      original.downloadToken,
      alternate.downloadToken,
    ]) {
      expect(response).not.toContain(secret);
      expect(JSON.stringify(logs)).not.toContain(secret);
    }
  });

  it('resolves the original manual pass ID after the request object and nested input are replaced', async () => {
    const { original, other } = await passes();
    const { actor } = await scannerForLookup();
    const input = { passId: original.id, method: 'manual' as const };
    const req = { idempotencyKey: key(), input, clientTs: kit.clock.now() };
    const result = await pauseCrypto(
      'sign',
      KEYSET_FRAME,
      () => resolveOutcome(kit.ctx, actor, req),
      () => {
        input.passId = other.id;
        req.input = { passId: other.id, method: 'manual' };
      },
    );
    expect(result.outcome).toMatchObject({ kind: 'ready', card: { passId: original.id } });
    expect(result.evaluatedSnapshot?.pass.id).toBe(original.id);
    expect(result.credentialContext).toMatchObject({
      credentialTombstoneRefs: [],
      otherModeCredentialTombstoneRefs: [],
    });
    expect(JSON.stringify(result.outcome)).not.toContain(other.id);
  });

  it('derives original code references even if the caller changes the code during the keyset await', async () => {
    const { originalCode, otherCode } = await passes();
    const input = { code: originalCode, method: 'camera' as const };
    const expected = await credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', input);
    const other = await credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', {
      code: otherCode,
      method: 'camera',
    });
    expect(expected.credentialTombstoneRefs.length).toBeGreaterThan(0);
    expect(other.credentialTombstoneRefs).not.toEqual(expected.credentialTombstoneRefs);
    const actual = await pauseCrypto(
      'sign',
      KEYSET_FRAME,
      () => credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', input),
      () => {
        input.code = otherCode;
      },
    );
    expect(actual).toEqual(expected);
    for (const secret of [originalCode, otherCode])
      expect(JSON.stringify(actual)).not.toContain(secret);
  });

  it('retains a pass-ID input kind when its caller changes the union shape during keyset work', async () => {
    const { original, otherCode } = await passes();
    const input: { passId?: string; code?: string; method: 'manual' } = {
      passId: original.id,
      method: 'manual',
    };
    const actual = await pauseCrypto(
      'sign',
      KEYSET_FRAME,
      () => credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', input as ScanInput),
      () => {
        delete input.passId;
        input.code = otherCode;
      },
    );
    expect(actual).toMatchObject({
      credentialTombstoneRefs: [],
      otherModeCredentialTombstoneRefs: [],
    });
    expect(JSON.stringify(actual)).not.toContain(otherCode);
  });

  it('evaluates the original code while deriving its credential context asynchronously', async () => {
    const { original, originalCode, otherCode } = await passes();
    const { actor } = await scannerForLookup();
    const input = { code: originalCode, method: 'camera' as const };
    const expected = await credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', input);
    const result = await pauseCrypto(
      'sign',
      KEYSET_FRAME,
      () => evaluate(kit.ctx, actor, input),
      () => {
        input.code = otherCode;
      },
    );
    expect(result.stop).toBe(false);
    if (result.stop) throw new Error('Original credential was not evaluated');
    expect(result.found.pass.id).toBe(original.id);
    expect(result.found.credentialTombstoneRefs).toEqual(expected.credentialTombstoneRefs);
    expect(result.found.otherModeCredentialTombstoneRefs).toEqual(
      expected.otherModeCredentialTombstoneRefs,
    );
    expect(result.found.credentialKeysetCommitment).toBe(expected.credentialKeysetCommitment);
  });

  it('keeps the original actor scope and unconfirmed flag waiver during evaluation', async () => {
    const flaggedTemplate = await kit.scanTemplate('Flagged mutation scope', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
      flags: [{ input: 'tier', label: 'Review required', equals: ['overdue'], stop: true }],
    });
    const original = await kit.scanPass(flaggedTemplate, {
      memberName: 'Original Flagged Member',
      tier: 'overdue',
    });
    const alternate = await kit.scanPass(flaggedTemplate, {
      memberName: 'Other Flagged Member',
      tier: 'gold',
    });
    if (!original.scanCode || !alternate.scanCode)
      throw new Error('Missing flag fixture credentials');
    const scanner = await kit.scanner({ templateIds: [flaggedTemplate] });
    const row = await getScanner(kit.env.DB, scanner.id);
    if (!row) throw new Error('Missing scanner fixture');
    const scope = await readScannerScope(kit.env.DB, row, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
      { keysetPolicy: 'defer' },
    );
    const input = { code: original.scanCode, method: 'camera' as const };
    const waive = { confirmed: false };
    const result = await pauseCrypto(
      'sign',
      KEYSET_FRAME,
      () => evaluate(kit.ctx, actor, input, waive),
      () => {
        input.code = alternate.scanCode!;
        actor.templateIds[0] = templateId;
        waive.confirmed = true;
      },
    );
    expect(result).toMatchObject({
      stop: true,
      kind: 'heads_up',
      reason: 'check_required',
      found: { pass: { id: original.id } },
    });
  });

  it('evaluates the original pass ID when it changes during keyset work', async () => {
    const { original, other } = await passes();
    const { actor } = await scannerForLookup();
    const input = { passId: original.id, method: 'manual' as const };
    const result = await pauseCrypto(
      'sign',
      KEYSET_FRAME,
      () => evaluate(kit.ctx, actor, input),
      () => {
        input.passId = other.id;
      },
    );
    expect(result.stop).toBe(false);
    if (result.stop) throw new Error('Original manual pass was not evaluated');
    expect(result.found.pass.id).toBe(original.id);
  });

  it('pins supplied own and other-mode refs plus commitment before candidate hashing', async () => {
    const { original, originalCode, otherCode } = await passes();
    const { actor } = await scannerForLookup();
    const input = { code: originalCode, method: 'camera' as const };
    const expected = await credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', input);
    const substitute = await credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', {
      code: otherCode,
      method: 'camera',
    });
    expect(expected.credentialTombstoneRefs).not.toEqual(substitute.credentialTombstoneRefs);
    expect(expected.otherModeCredentialTombstoneRefs).not.toEqual(
      substitute.otherModeCredentialTombstoneRefs,
    );
    const supplied = {
      ...expected,
      credentialTombstoneRefs: [...expected.credentialTombstoneRefs],
      otherModeCredentialTombstoneRefs: [...expected.otherModeCredentialTombstoneRefs],
    };
    const result = await pauseCrypto(
      'digest',
      originalCode,
      () => evaluate(kit.ctx, actor, input, {}, supplied),
      () => {
        supplied.credentialTombstoneRefs.splice(
          0,
          supplied.credentialTombstoneRefs.length,
          ...substitute.credentialTombstoneRefs,
        );
        supplied.otherModeCredentialTombstoneRefs.splice(
          0,
          supplied.otherModeCredentialTombstoneRefs.length,
          ...substitute.otherModeCredentialTombstoneRefs,
        );
        supplied.credentialKeysetCommitment = '0'.repeat(64);
      },
    );
    expect(result.stop).toBe(false);
    if (result.stop) throw new Error('Original credential context was not evaluated');
    expect(result.found.pass.id).toBe(original.id);
    expect(result.found.credentialTombstoneRefs).toEqual(expected.credentialTombstoneRefs);
    expect(result.found.otherModeCredentialTombstoneRefs).toEqual(
      expected.otherModeCredentialTombstoneRefs,
    );
    expect(result.found.credentialKeysetCommitment).toBe(expected.credentialKeysetCommitment);
  });
});
