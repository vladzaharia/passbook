import {
  TagProgramAuthSchema,
  TagProgramProbeSchema,
  TagProgramReauthedSchema,
  TagProgramReauthSchema,
  TagProgramResultSchema,
  type TagProgramStart,
  TagProgramStartedSchema,
  TagProgramStartSchema,
  TagProgramStepSchema,
} from '../../../../../shared/contracts/nfc-tag-programs.ts';
import { bytesToHex, hexToBytes } from '../../sun.ts';
import {
  expectSw,
  INS,
  ISO_FILE_NDEF,
  native,
  readBinary,
  SW,
  selectFile,
  selectNdefApp,
  splitResponse,
} from '../apdu.ts';
import { authFinish, authFirstApdu, authPart2, type Ev2Session } from '../ev2.ts';

export type Send = (apdu: Uint8Array) => Promise<Uint8Array>;

/** What a hold talks to: the reference relay, or the product's service behind an adapter. */
export interface RelayPort {
  start(req: TagProgramStart): Promise<{ id: string; resume: boolean; apdus: string[] }>;
  auth(id: string, req: { responses: string[] }): Promise<unknown>;
  reauth(id: string, req: { responses: string[] }): Promise<unknown>;
  probe(id: string, req: { responses: string[] }): Promise<unknown>;
  result(id: string, req: { responses: string[]; url: string }): Promise<unknown>;
}

const hex = bytesToHex;
const h = (s: string) => hexToBytes(s) as Uint8Array;

/** The device: runs a batch in order and stops at the first status word outside 9100 and 9000. */
async function runBatch(send: Send, apdus: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const apdu of apdus) {
    const answer = await send(h(apdu));
    out.push(hex(answer));
    const { sw } = splitResponse(answer);
    if (sw !== SW.ok && sw !== 0x9000) break;
  }
  return out;
}

let holds = 0;

/**
 * Test support: one hold of the tag, the way the scanner app and the Worker do it: the device reads the
 * tag's own answers (version, signature, auth part 1), then relays opaque APDU batches to `server` through
 * start, auth, probe/reauth, script and result. Every message is parsed with the contract schemas. The
 * same call resumes after a tear, because the server keeps the row.
 */
export async function programTag(send: Send, server: RelayPort): Promise<string> {
  expectSw(splitResponse(await send(selectNdefApp())), 0x9000);
  const hw = expectSw(splitResponse(await send(native(INS.getVersion))), SW.more).data;
  const sw = expectSw(splitResponse(await send(native(INS.additional))), SW.more).data;
  const prod = expectSw(splitResponse(await send(native(INS.additional))), SW.ok).data;
  const sig = expectSw(
    splitResponse(await send(native(INS.readSig, new Uint8Array([0])))),
    SW.ok,
  ).data;
  const auth1 = expectSw(splitResponse(await send(authFirstApdu(0))), SW.more).data;
  const version = new Uint8Array([...hw, ...sw, ...prod]);
  const request = TagProgramStartSchema.parse({
    uid: hex(prod.slice(0, 7)),
    version: hex(version),
    sig: hex(sig),
    auth1: hex(auth1),
    purpose: 'blank',
    idem: `hold-000${++holds}`,
  });
  const started = await server.start(request);
  TagProgramStartedSchema.parse({ ...started, expiresAt: 1 });

  let answer = TagProgramAuthSchema.parse({ responses: await runBatch(send, started.apdus) });
  let step = TagProgramStepSchema.parse(await server.auth(started.id, answer));
  while (step.next === 'reauth') {
    const first = TagProgramReauthSchema.parse({ responses: await runBatch(send, step.apdus) });
    const second = TagProgramReauthedSchema.parse(await server.reauth(started.id, first));
    answer = TagProgramAuthSchema.parse({ responses: await runBatch(send, second.apdus) });
    step = TagProgramStepSchema.parse(await server.auth(started.id, answer));
  }
  if (step.next === 'probe') {
    const probe = TagProgramProbeSchema.parse({ responses: await runBatch(send, step.apdus) });
    step = TagProgramStepSchema.parse(await server.probe(started.id, probe));
  }
  if (step.next !== 'script') throw new Error('The server asked for another probe.');
  const responses = await runBatch(send, step.apdus);
  const url = await readUrl(send);
  const result = TagProgramResultSchema.parse({
    responses,
    readback: { tech: 'isodep', source: 'native', ndef: { type: 'U', value: url } },
  });
  await server.result(started.id, { responses: result.responses, url });
  return url;
}

/** AuthenticateEV2First against `key`, reader side only; a refusal is `NTAG_AUTH_FAILED`. */
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
  const payload = file.slice(2, 2 + length).slice(4);
  return `https://${new TextDecoder().decode(payload.slice(1))}`;
}
