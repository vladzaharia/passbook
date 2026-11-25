import { bytesToHex } from '../../sun.ts';
import {
  expectSw,
  FILE_NDEF,
  INS,
  ISO_FILE_NDEF,
  isNtag424,
  native,
  parseVersion,
  readBinary,
  SW,
  selectFile,
  selectNdefApp,
  splitResponse,
} from '../apdu.ts';
import { Ntag424Error, ZERO16 } from '../bytes.ts';
import { changeKey } from '../change-key.ts';
import { authFinish, authFirstApdu, authPart2, type Ev2Session } from '../ev2.ts';
import { changeFileSettings, sdmFileSettings, writeData } from '../file-settings.ts';
import { verifyOriginality } from '../originality.ts';
import type { Point } from '../p224.ts';
import { sunTemplate } from '../sdm-layout.ts';
import { checkBare, checkResponse, getKeyVersion, type Sent } from '../secure-messaging.ts';

const checked = new Map<string, boolean>();
/** The ECDSA check is slow in BigInt; a tag seen again in one test run is not verified again. */
function originalityOk(uid: Uint8Array, sig: Uint8Array, key: Point): boolean {
  const id = `${bytesToHex(uid)}${bytesToHex(sig)}${key[0].toString(16)}`;
  const known = checked.get(id);
  if (known !== undefined) return known;
  const ok = verifyOriginality(uid, sig, key);
  checked.set(id, ok);
  return ok;
}

export type Send = (apdu: Uint8Array) => Promise<Uint8Array>;

export interface ProgramPlan {
  /** The intended K0..K4. */
  keys: Uint8Array[];
  version: number;
  host: string;
  slug: string;
  originalityKey: Point;
}

/**
 * Test support: one attempt at programming a tag in the order the design gives, deciding at the start which
 * key the tag answers to. The same call resumes after a tear. The product's version of this is the server's
 * script builder; this is the reference the simulator tests hold it to.
 */
export async function programTag(send: Send, plan: ProgramPlan): Promise<string> {
  expectSw(splitResponse(await send(selectNdefApp())), 0x9000);
  const hw = expectSw(splitResponse(await send(native(INS.getVersion))), SW.more).data;
  const sw = expectSw(splitResponse(await send(native(INS.additional))), SW.more).data;
  const prod = expectSw(splitResponse(await send(native(INS.additional))), SW.ok).data;
  const version = parseVersion(hw, sw, prod);
  if (!isNtag424(version)) throw new Ntag424Error('NTAG_UNSUPPORTED', 'Not an NTAG 424 DNA.');
  const sig = expectSw(
    splitResponse(await send(native(INS.readSig, new Uint8Array([0])))),
    SW.ok,
  ).data;
  if (!originalityOk(version.uid, sig, plan.originalityKey))
    throw new Ntag424Error('NTAG_UNSUPPORTED', 'The originality signature does not verify.');

  let session: Ev2Session;
  let keyed = false;
  try {
    session = await authenticate(send, 0, ZERO16);
  } catch (e) {
    if (!(e instanceof Ntag424Error) || e.code !== 'NTAG_AUTH_FAILED') throw e;
    session = await authenticate(send, 0, plan.keys[0] as Uint8Array);
    keyed = true;
  }
  const run = async (built: { apdu: Uint8Array; sent: Sent }) =>
    checkResponse(session, built.sent, await send(built.apdu));

  const old: Uint8Array[] = [];
  if (!keyed) {
    for (let n = 1; n <= 4; n++) {
      const v = (await run(await getKeyVersion(session, n)))[0];
      old[n] = v === plan.version ? (plan.keys[n] as Uint8Array) : ZERO16;
    }
  }
  const template = sunTemplate(plan.host, plan.slug);
  await run(await writeData(session, FILE_NDEF, 0, template.file));
  await run(await changeFileSettings(session, FILE_NDEF, sdmFileSettings(template)));
  if (!keyed) {
    for (const n of [1, 2, 3, 4]) {
      await run(
        await changeKey(session, {
          keyNo: n,
          newKey: plan.keys[n] as Uint8Array,
          oldKey: old[n],
          version: plan.version,
        }),
      );
    }
    const last = await changeKey(session, {
      keyNo: 0,
      newKey: plan.keys[0] as Uint8Array,
      version: plan.version,
    });
    checkBare(await send(last.apdu));
  }
  return readUrl(send);
}

/** AuthenticateEV2First against `key`; a refusal is `NTAG_AUTH_FAILED`. */
export async function authenticate(
  send: Send,
  keyNo: number,
  key: Uint8Array,
  rndA: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): Promise<Ev2Session> {
  const first = expectSw(splitResponse(await send(authFirstApdu(keyNo))), SW.more);
  const part2 = await authPart2(key, first.data, rndA);
  const second = expectSw(splitResponse(await send(part2.apdu)), SW.ok);
  return authFinish(key, keyNo, rndA, part2.rndB, second.data);
}

/** The URL file 02 reads as, through the free ISO read. */
export async function readUrl(send: Send): Promise<string> {
  expectSw(splitResponse(await send(selectFile(ISO_FILE_NDEF))), 0x9000);
  const file = expectSw(splitResponse(await send(readBinary())), 0x9000).data;
  const length = ((file[0] as number) << 8) | (file[1] as number);
  const record = file.slice(2, 2 + length);
  const payload = record.slice(4);
  return `https://${new TextDecoder().decode(payload.slice(1))}`;
}
