import { ASC_BASE, type AscResponse, ascRequest, type Deps, failure } from './asc-http.ts';
import {
  certificate,
  ID,
  many,
  one,
  passType,
  type Resource,
  str,
  toBase64,
} from './asc-resources.ts';
import { assertCsr } from './csr.ts';
import {
  type Allowed,
  alert,
  allowedByAscId,
  allowedByIdentifier,
  finish,
  hasSettledReplacement,
  logRefusal,
  markActive,
  readCalls,
  rememberCertificate,
  rememberPassType,
  reserve,
  takeRevokeSlot,
} from './ledger.ts';
import {
  assertManagedIdentifier,
  assertOrderable,
  assertPassTypeName,
  assertRevokeReason,
  managedIdentifier,
  OWNER_REVOKE,
  platformPassType,
  refuse,
} from './policy.ts';
import {
  type AppleRpc,
  AscError,
  type CreatedPassType,
  type PassTypeRef,
  type ProvisionerEnv,
} from './types.ts';

const MAX_PAGES = 50;

/** The next page's path from Apple's `links.next`, only when it stays on the ASC host. */
function nextPath(res: AscResponse): string | null {
  const next = (res.body as { links?: { next?: unknown } } | null)?.links?.next;
  if (typeof next !== 'string') return null;
  try {
    const url = new URL(next);
    return url.origin === ASC_BASE ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

type Req = (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  payload?: unknown,
) => Promise<AscResponse>;
/** The provisioner's RPC methods over injectable I/O. The entrypoint class only delegates here. */
export function createApi(env: ProvisionerEnv, deps: Deps): AppleRpc {
  const db = env.DB;

  /** Allowlist and input checks. A refusal is ledgered, then thrown; Apple is not called. */
  async function guard<T>(
    method: string,
    target: string | null,
    runId: string | undefined,
    check: () => Promise<T>,
  ): Promise<T> {
    try {
      return await check();
    } catch (error) {
      if (error instanceof AscError && error.code === 'ASC_REFUSED')
        await logRefusal(db, method, target, runId ?? null, deps.now(), error.message);
      throw error;
    }
  }

  /** Reserves budget, runs `fn`, and ledgers the outcome (status and request id of the last Apple request). */
  async function ledgered<T>(
    method: string,
    target: string | null,
    runId: string | undefined,
    fn: (req: Req) => Promise<T>,
  ): Promise<T> {
    const callId = crypto.randomUUID();
    const caller = runId ?? null;
    const started = deps.now();
    await reserve(db, callId, method, target, caller, started);
    let last: { status: string | null; requestId: string | null } = {
      status: null,
      requestId: null,
    };
    const req: Req = async (m, path, payload) => {
      const res = await ascRequest(env, deps, m, path, payload);
      last = { status: String(res.status), requestId: res.requestId };
      return res;
    };
    let result: { value: T } | undefined;
    let failed: unknown;
    try {
      result = { value: await fn(req) };
    } catch (error) {
      failed = error;
      if (error instanceof AscError) {
        // The code, not the last HTTP status: a refused lookup that read 200 must not ledger as 200.
        last.status = error.code;
        if (error.code === 'ASC_REFUSED')
          await logRefusal(db, method, target, caller, deps.now(), error.message);
      }
    }
    try {
      await finish(
        db,
        callId,
        method,
        target,
        caller,
        {
          status: last.status ?? 'error',
          requestId: last.requestId,
          durationMs: deps.now() - started,
        },
        deps.now(),
      );
    } catch {
      // The Apple call already happened: a ledger write failure must not hide its outcome.
      alert('error', 'provisioner.ledger_write_failed', { method, callId });
    }
    if (result) return result.value;
    throw failed;
  }

  const requireAllowed = async (ascId: string): Promise<Allowed> =>
    (await allowedByAscId(db, ascId)) ?? refuse('Pass type is not in the allowlist.');

  async function lookup(req: Req, identifier: string): Promise<PassTypeRef | null> {
    let path: string | null =
      `/v1/passTypeIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=200`;
    // Apple may filter by prefix: read every page, since the exact match can be on any of them.
    for (let page = 0; path && page < MAX_PAGES; page++) {
      const res = await req('GET', path);
      const found = many(res)
        .map(passType)
        .find((p) => p.identifier === identifier);
      if (found) return found;
      path = nextPath(res);
    }
    return null;
  }

  /** The allowlisted pass type a certificate belongs to, read from Apple. */
  async function certificateOwner(
    req: Req,
    certAscId: string,
  ): Promise<Allowed & { ascId: string; cert: Resource }> {
    const cert = one(await req('GET', `/v1/certificates/${certAscId}?include=passTypeId`));
    const rel = (cert.relationships as { passTypeId?: { data?: { id?: unknown } } } | undefined)
      ?.passTypeId;
    const owner = str(rel?.data?.id);
    const allowed = owner ? await allowedByAscId(db, owner) : null;
    if (!owner || !allowed) refuse('Certificate does not belong to an allowlisted pass type.');
    return { ...(allowed as Allowed), ascId: owner as string, cert };
  }

  /** Creates the pass type, or adopts it when Apple already has it; the same ledger and budget for every caller. */
  async function orderPassType(
    identifier: string,
    name: string,
    runId: string | undefined,
  ): Promise<CreatedPassType> {
    const known = await allowedByIdentifier(db, identifier);
    if (known?.ascId)
      return { ascId: known.ascId, identifier, name: known.name, outcome: 'existing' };
    // One budget bucket for every caller that orders a pass type.
    return ledgered('createPassType', identifier, runId, async (req) => {
      const res = await req('POST', '/v1/passTypeIds', {
        data: { type: 'passTypeIds', attributes: { identifier, name } },
      });
      // A lost response from an earlier attempt: Apple already has it, so adopt it.
      const adopted = res.status === 409;
      const created = adopted ? await lookup(req, identifier) : passType(one(res));
      if (!created) throw failure(res);
      if (created.identifier !== identifier) refuse('Apple returned a different pass type.');
      await rememberPassType(
        db,
        identifier,
        created.ascId,
        created.name ?? name,
        'created',
        deps.now(),
      );
      return { ...created, outcome: adopted ? 'adopted' : 'created' } satisfies CreatedPassType;
    });
  }

  return {
    async createPassType(handle, name, runId) {
      const identifier = await guard('createPassType', null, runId, async () => {
        assertPassTypeName(name);
        return managedIdentifier(handle);
      });
      return orderPassType(identifier, name, runId);
    },

    async createPlatformPassType(slot, runId) {
      const { identifier, name } = await guard('createPlatformPassType', null, runId, async () =>
        platformPassType(slot),
      );
      return orderPassType(identifier, name, runId);
    },

    async createCertificate(passTypeAscId, csrDer, nfc, runId) {
      const type = nfc ? 'PASS_TYPE_ID_WITH_NFC' : 'PASS_TYPE_ID';
      await guard('createCertificate', passTypeAscId, runId, async () => {
        const allowed = await requireAllowed(passTypeAscId);
        assertOrderable(allowed.identifier);
        await assertCsr(csrDer, allowed.identifier);
      });
      return ledgered('createCertificate', passTypeAscId, runId, async (req) => {
        const created = certificate(
          one(
            await req('POST', '/v1/certificates', {
              data: {
                type: 'certificates',
                attributes: { certificateType: type, csrContent: toBase64(csrDer) },
                relationships: { passTypeId: { data: { type: 'passTypeIds', id: passTypeAscId } } },
              },
            }),
          ),
        );
        await rememberCertificate(db, created.ascId, passTypeAscId, deps.now());
        alert('warn', 'provisioner.cert_ordered', { passTypeAscId });
        return created;
      });
    },

    async reportCertificateActive(certAscId, runId) {
      await guard('reportCertificateActive', certAscId, runId, async () => {
        if (!ID.test(certAscId)) refuse('Invalid certificate id.');
      });
      await ledgered('reportCertificateActive', certAscId, runId, async (req) => {
        const owner = await certificateOwner(req, certAscId);
        assertOrderable(owner.identifier);
        // A certificate whose order response was lost is adopted now, so its cool-off starts now.
        await rememberCertificate(db, certAscId, owner.ascId, deps.now());
        await markActive(db, certAscId, deps.now());
      });
    },

    async listCertificates(passTypeAscId, runId) {
      await guard('listCertificates', passTypeAscId, runId, () => requireAllowed(passTypeAscId));
      return ledgered('listCertificates', passTypeAscId, runId, async (req) =>
        many(
          await req(
            'GET',
            `/v1/passTypeIds/${encodeURIComponent(passTypeAscId)}/certificates?limit=200`,
          ),
        ).map(certificate),
      );
    },

    async revokeCertificate(certAscId, reason, runId) {
      await guard('revokeCertificate', certAscId, runId, async () => {
        assertRevokeReason(reason);
        if (!ID.test(certAscId)) refuse('Invalid certificate id.');
      });
      // The owner lookup is its own ledgered call, so a refused lookup never uses the hourly revoke slot.
      const owner = await ledgered('revokeCertificate.read', certAscId, runId, async (req) => {
        const found = await certificateOwner(req, certAscId);
        if (OWNER_REVOKE.has(found.identifier))
          refuse('Platform pass type certificates are revoked by the owner only.');
        // Installed passes depend on the newest certificate: only a superseded one may go.
        const mine = certificate(found.cert);
        const all = many(
          await req(
            'GET',
            `/v1/passTypeIds/${encodeURIComponent(found.ascId)}/certificates?limit=200`,
          ),
        ).map(certificate);
        const newer = all.some(
          (c) => c.ascId !== mine.ascId && (c.expiresAt ?? 0) > (mine.expiresAt ?? 0),
        );
        if (!newer) refuse('Refusing to revoke the newest certificate of a pass type.');
        // The provisioner's own state, not the caller's word: a replacement ordered a moment ago does not count.
        if (!(await hasSettledReplacement(db, found.ascId, certAscId, deps.now())))
          refuse('A replacement must be active and at least 24 hours old before a revoke.');
        return found.ascId;
      });
      await ledgered('revokeCertificate', certAscId, runId, async (req) => {
        if (!(await takeRevokeSlot(db, certAscId, owner, deps.now())))
          refuse('This pass type already had a revoke in the last 7 days.');
        alert('error', 'provisioner.cert_revoked', { passTypeAscId: owner });
        const res = await req('DELETE', `/v1/certificates/${certAscId}`);
        if (res.status !== 204 && res.status !== 200) throw failure(res);
      });
    },

    async findPassType(identifier, runId) {
      await guard('findPassType', identifier, runId, async () => {
        if (!(await allowedByIdentifier(db, identifier))) assertManagedIdentifier(identifier);
      });
      return ledgered('findPassType', identifier, runId, async (req) => {
        const found = await lookup(req, identifier);
        // A seeded row gets its id; a managed identifier an earlier attempt created joins the allowlist.
        if (found) {
          const seeded = (await allowedByIdentifier(db, identifier)) !== null;
          await rememberPassType(
            db,
            identifier,
            found.ascId,
            found.name,
            seeded ? 'seeded' : 'created',
            deps.now(),
          );
        }
        return found;
      });
    },

    calls: (since) => readCalls(db, since),
  };
}
