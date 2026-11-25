import { FILE_NDEF } from './ntag424/apdu.ts';
import { ZERO16 } from './ntag424/bytes.ts';
import { changeKey } from './ntag424/change-key.ts';
import type { Ev2Session } from './ntag424/ev2.ts';
import { changeFileSettings, sdmFileSettings, writeData } from './ntag424/file-settings.ts';
import { sunTemplate } from './ntag424/sdm-layout.ts';
import { checkBare, checkResponse, getKeyVersion, type Sent } from './ntag424/secure-messaging.ts';
import { type Expect, hex, type SessionState, unhex } from './program-seal.ts';

/** The session a hold opened, as the next call finds it. Never `dead`: a dead one is not stored. */
export const sessionOf = (state: SessionState): Ev2Session => {
  const ses = state.ses;
  if (!ses) throw new RangeError('The hold has no session yet.');
  return {
    keyNo: 0,
    ti: unhex(ses.ti),
    encKey: unhex(ses.enc),
    macKey: unhex(ses.mac),
    ctr: ses.ctr,
    dead: false,
  };
};

export const sesOf = (s: Ev2Session): NonNullable<SessionState['ses']> => ({
  enc: hex(s.encKey),
  mac: hex(s.macKey),
  ti: hex(s.ti),
  ctr: s.ctr,
});

/** GetKeyVersion for keys 1 to 4, MAC'd, in one batch. Native commands only: no ISO command inside a session. */
export async function probeBatch(s: Ev2Session): Promise<{ apdus: string[]; probes: number[] }> {
  const apdus: string[] = [];
  const probes: number[] = [];
  for (let n = 1; n <= 4; n++) {
    const built = await getKeyVersion(s, n);
    apdus.push(hex(built.apdu));
    probes.push(built.sent.ctr);
  }
  return { apdus, probes };
}

export interface ScriptPlan {
  /** K0 to K4 as intended. */
  keys: Uint8Array[];
  version: number;
  host: string;
  slug: string;
  /** The keys now in slots 1 to 4 (index 0 is key 1): the factory zeros, or the intended key where the probe saw our version. */
  old: Uint8Array[];
  /** Authenticated with the intended K0 already: the keys are in, so only the NDEF and its settings are rewritten. */
  keyed: boolean;
}

/**
 * The whole post-auth script: NDEF to file 02 (Plain: no MAC, the counter still moves), the SDM settings,
 * ChangeKey for keys 1 to 4 and key 0 last (it ends the session, so its bare 9100 proves nothing the tag can
 * show). A tag that tears anywhere in it is resumed from the probe, never by new keys.
 */
export async function scriptBatch(
  s: Ev2Session,
  plan: ScriptPlan,
): Promise<{ apdus: string[]; expect: Expect[] }> {
  const template = sunTemplate(plan.host, plan.slug);
  const apdus: string[] = [];
  const expect: Expect[] = [];
  const add = (built: { apdu: Uint8Array; sent: Sent }, kind: Expect['kind']) => {
    apdus.push(hex(built.apdu));
    expect.push({ ctr: built.sent.ctr, kind });
  };
  add(await writeData(s, FILE_NDEF, 0, template.file), 'bare');
  add(await changeFileSettings(s, FILE_NDEF, sdmFileSettings(template)), 'mac');
  if (!plan.keyed) {
    for (const n of [1, 2, 3, 4])
      add(
        await changeKey(s, {
          keyNo: n,
          newKey: plan.keys[n] as Uint8Array,
          oldKey: plan.old[n - 1] ?? ZERO16,
          version: plan.version,
        }),
        'mac',
      );
    add(
      await changeKey(s, { keyNo: 0, newKey: plan.keys[0] as Uint8Array, version: plan.version }),
      'bare',
    );
  }
  return { apdus, expect };
}

export type Checked =
  | { ok: true; bodies: Uint8Array[] }
  /** `short`: the device stopped before the end (the tag left); `bad`: a refusal, a bad MAC or a malformed answer. */
  | { ok: false; why: 'short' | 'bad' };

/**
 * Checks every response in order against `sent.ctr + 1`; the first bad MAC, status other than 9100 or malformed
 * answer ends it (the tag ends its session there, so nothing after it can be trusted).
 */
export async function checkBatch(
  s: Ev2Session,
  expect: Expect[],
  responses: string[],
): Promise<Checked> {
  const bodies: Uint8Array[] = [];
  for (const [i, e] of expect.entries()) {
    const raw = responses[i] === undefined ? null : unhex(responses[i] as string);
    if (raw === null) return { ok: false, why: 'short' };
    try {
      if (e.kind === 'bare') {
        checkBare(s, raw);
        bodies.push(new Uint8Array(0));
      } else bodies.push(await checkResponse(s, { ctr: e.ctr }, raw));
    } catch {
      s.dead = true;
      return { ok: false, why: 'bad' };
    }
  }
  return responses.length > expect.length ? { ok: false, why: 'bad' } : { ok: true, bodies };
}
