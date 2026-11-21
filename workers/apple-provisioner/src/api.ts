import { type AscResponse, ascRequest, type Deps, failure } from './asc-http.ts';
import { assertCsr } from './csr.ts';
import {
  type Allowed,
  allowedByAscId,
  allowedByIdentifier,
  finish,
  logRefusal,
  readCalls,
  rememberPassType,
  reserve,
} from './ledger.ts';
import {
  assertManagedIdentifier,
  assertPassTypeName,
  assertRevokeReason,
  managedIdentifier,
  PLATFORM_IDENTIFIERS,
  refuse,
} from './policy.ts';
import {
  type AppleRpc,
  AscError,
  type CertificateInfo,
  type PassTypeRef,
  type ProvisionerEnv,
} from './types.ts';

type Req = (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  payload?: unknown,
) => Promise<AscResponse>;
type Resource = { id?: string; attributes?: Record<string, unknown>; relationships?: unknown };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function passType(r: Resource): PassTypeRef {
  const ascId = str(r.id);
  const identifier = str(r.attributes?.identifier);
  if (!ascId || !identifier)
    throw new AscError('ASC_UPSTREAM', 'Apple returned an unexpected pass type.');
  return { ascId, identifier, name: str(r.attributes?.name) };
}

function certificate(r: Resource): CertificateInfo {
  const ascId = str(r.id);
  if (!ascId) throw new AscError('ASC_UPSTREAM', 'Apple returned an unexpected certificate.');
  const content = str(r.attributes?.certificateContent);
  const expires = Date.parse(str(r.attributes?.expirationDate) ?? '');
  return {
    ascId,
    certificateType: str(r.attributes?.certificateType) ?? '',
    serialNumber: str(r.attributes?.serialNumber),
    expiresAt: Number.isNaN(expires) ? null : expires,
    der: content ? fromBase64(content) : null,
  };
}

const one = (res: AscResponse): Resource => {
  if (res.status < 200 || res.status >= 300) throw failure(res);
  const data = res.body?.data;
  if (!data || Array.isArray(data))
    throw new AscError('ASC_UPSTREAM', 'Apple returned no resource.');
  return data as Resource;
};
const many = (res: AscResponse): Resource[] => {
  if (res.status < 200 || res.status >= 300) throw failure(res);
  return Array.isArray(res.body?.data) ? (res.body.data as Resource[]) : [];
};

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
    try {
      return await fn(req);
    } catch (error) {
      if (error instanceof AscError) {
        // The code, not the last HTTP status: a refused lookup that read 200 must not ledger as 200.
        last.status = error.code;
        if (error.code === 'ASC_REFUSED')
          await logRefusal(db, method, target, caller, deps.now(), error.message);
      }
      throw error;
    } finally {
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
    }
  }

  const requireAllowed = async (ascId: string): Promise<Allowed> =>
    (await allowedByAscId(db, ascId)) ?? refuse('Pass type is not in the allowlist.');

  async function lookup(req: Req, identifier: string): Promise<PassTypeRef | null> {
    const res = await req(
      'GET',
      `/v1/passTypeIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=10`,
    );
    return (
      many(res)
        .map(passType)
        .find((p) => p.identifier === identifier) ?? null
    );
  }

  return {
    async createPassType(handle, name, runId) {
      const identifier = await guard('createPassType', null, runId, async () => {
        assertPassTypeName(name);
        return managedIdentifier(handle);
      });
      const known = await allowedByIdentifier(db, identifier);
      if (known?.ascId) return { ascId: known.ascId, identifier, name: known.name };
      return ledgered('createPassType', identifier, runId, async (req) => {
        const res = await req('POST', '/v1/passTypeIds', {
          data: { type: 'passTypeIds', attributes: { identifier, name } },
        });
        // A lost response from an earlier attempt: Apple already has it, so adopt it.
        const created = res.status === 409 ? await lookup(req, identifier) : passType(one(res));
        if (!created) throw failure(res);
        await rememberPassType(
          db,
          identifier,
          created.ascId,
          created.name ?? name,
          'created',
          deps.now(),
        );
        return created;
      });
    },

    async createCertificate(passTypeAscId, csrDer, nfc, runId) {
      const type = nfc ? 'PASS_TYPE_ID_WITH_NFC' : 'PASS_TYPE_ID';
      await guard('createCertificate', passTypeAscId, runId, async () => {
        const allowed = await requireAllowed(passTypeAscId);
        await assertCsr(csrDer, allowed.identifier);
      });
      return ledgered('createCertificate', passTypeAscId, runId, async (req) =>
        certificate(
          one(
            await req('POST', '/v1/certificates', {
              data: {
                type: 'certificates',
                attributes: { certificateType: type, csrContent: toBase64(csrDer) },
                relationships: { passTypeId: { data: { type: 'passTypeIds', id: passTypeAscId } } },
              },
            }),
          ),
        ),
      );
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
      await ledgered('revokeCertificate.read', certAscId, runId, async (req) => {
        const cert = one(await req('GET', `/v1/certificates/${certAscId}?include=passTypeId`));
        const rel = (cert.relationships as { passTypeId?: { data?: { id?: unknown } } } | undefined)
          ?.passTypeId;
        const owner = str(rel?.data?.id);
        const allowed = owner ? await allowedByAscId(db, owner) : null;
        if (!owner || !allowed) refuse('Certificate does not belong to an allowlisted pass type.');
        if (PLATFORM_IDENTIFIERS.has(allowed?.identifier ?? ''))
          refuse('Platform pass type certificates are revoked by the owner only.');
        // Installed passes depend on the newest certificate: only a superseded one may go.
        const mine = certificate(cert);
        const all = many(
          await req(
            'GET',
            `/v1/passTypeIds/${encodeURIComponent(owner ?? '')}/certificates?limit=200`,
          ),
        ).map(certificate);
        const newer = all.some(
          (c) => c.ascId !== mine.ascId && (c.expiresAt ?? 0) > (mine.expiresAt ?? 0),
        );
        if (!newer) refuse('Refusing to revoke the newest certificate of a pass type.');
      });
      await ledgered('revokeCertificate', certAscId, runId, async (req) => {
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
        if (found && (await allowedByIdentifier(db, identifier)))
          await rememberPassType(db, identifier, found.ascId, found.name, 'seeded', deps.now());
        return found;
      });
    },

    calls: (since) => readCalls(db, since),
  };
}
