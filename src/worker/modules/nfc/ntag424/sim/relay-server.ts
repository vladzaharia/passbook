import { bytesToHex, hexToBytes, verifySun } from '../../sun.ts';
import { parseSunUrl } from '../../sun-url.ts';
import { FILE_NDEF, isNtag424, parseVersion, SW, splitResponse } from '../apdu.ts';
import { Ntag424Error, ZERO16 } from '../bytes.ts';
import { changeKey } from '../change-key.ts';
import { authFinish, authFirstApdu, authPart2, type Ev2Session } from '../ev2.ts';
import { changeFileSettings, sdmFileSettings, writeData } from '../file-settings.ts';
import { type Point, verifyUidSignature } from '../p224.ts';
import { sunTemplate } from '../sdm-layout.ts';
import { checkBare, checkResponse, getKeyVersion, type Sent } from '../secure-messaging.ts';

export interface ProgramPlan {
  /** The intended K0..K4. */
  keys: Uint8Array[];
  version: number;
  host: string;
  slug: string;
  originalityKey: Point;
}

type Step =
  | { next: 'probe'; apdus: string[]; stopOn: '9100' }
  | { next: 'reauth'; apdus: string[] }
  | { next: 'script'; apdus: string[]; stopOn: '9100' };

interface Expect {
  sent: Sent;
  kind: 'mac' | 'bare';
}

interface Row {
  id: string;
  resumed: boolean;
  candidate: 0 | 1;
  rndA: Uint8Array;
  rndB: Uint8Array;
  session: Ev2Session | null;
  old: Uint8Array[];
  probes: Sent[];
  script: Expect[];
  state: 'started' | 'scripted' | 'programmed';
}

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const h = (hex: string) => hexToBytes(hex) as Uint8Array;

/**
 * Test support: the server's side of the relay, with the intended keys fixed by a plan. It keeps a row per
 * UID across holds, so a second `start` resumes: the factory key is tried first, the intended key 0 after a
 * refusal, and a resumed row probes the key versions before any ChangeKey. The product's service (P4)
 * implements the same steps against the contract; this is what the simulator tests hold the flow to.
 */
export class RelayServer {
  private readonly rows = new Map<string, Row>();
  private readonly seen = new Map<string, boolean>();
  private seq = 0;

  readonly plan: ProgramPlan;
  private readonly random: (n: number) => Uint8Array;

  constructor(plan: ProgramPlan, random: (n: number) => Uint8Array = randomBytes) {
    this.plan = plan;
    this.random = random;
  }

  /** `version` is the three GetVersion parts joined (28 bytes); `auth1` is the tag's answer to auth part 1. */
  async start(req: { version: string; sig: string; auth1: string }) {
    const v = h(req.version);
    const version = parseVersion(v.slice(0, 7), v.slice(7, 14), v.slice(14));
    if (!isNtag424(version)) throw new Ntag424Error('NTAG_UNSUPPORTED', 'Not an NTAG 424 DNA.');
    if (!this.genuine(version.uid, h(req.sig)))
      throw new Ntag424Error('NTAG_UNSUPPORTED', 'The originality signature does not verify.');
    const uid = bytesToHex(version.uid);
    const known = this.rows.get(uid);
    const row: Row = known ?? {
      id: `program-${++this.seq}`,
      resumed: false,
      candidate: 0,
      rndA: ZERO16,
      rndB: ZERO16,
      session: null,
      old: [],
      probes: [],
      script: [],
      state: 'started',
    };
    row.resumed = known !== undefined;
    row.candidate = 0;
    this.rows.set(uid, row);
    return { id: row.id, resume: row.resumed, apdus: [await this.part2(row, h(req.auth1))] };
  }

  async auth(id: string, req: { responses: string[] }): Promise<Step> {
    const row = this.row(id);
    const r = splitResponse(h(req.responses[0] as string));
    if (r.sw === SW.authError && row.resumed && row.candidate === 0) {
      row.candidate = 1;
      return { next: 'reauth', apdus: [bytesToHex(authFirstApdu(0))] };
    }
    if (r.sw !== SW.ok) throw new Ntag424Error('NTAG_AUTH_FAILED', 'The tag refused the key.');
    const key = this.keyOf(row);
    row.session = await authFinish(key, 0, row.rndA, row.rndB, r.data);
    row.state = 'scripted';
    if (row.candidate === 1) return this.script(row, true);
    if (!row.resumed) return this.script(row, false);
    row.probes = [];
    const apdus: string[] = [];
    for (let n = 1; n <= 4; n++) {
      const built = await getKeyVersion(row.session, n);
      row.probes.push(built.sent);
      apdus.push(bytesToHex(built.apdu));
    }
    return { next: 'probe', apdus, stopOn: '9100' };
  }

  async reauth(id: string, req: { responses: string[] }) {
    const row = this.row(id);
    const r = splitResponse(h(req.responses[0] as string));
    if (r.sw !== SW.more) throw new Ntag424Error('NTAG_AUTH_FAILED', 'The tag refused the key.');
    return { apdus: [await this.part2(row, r.data)] };
  }

  async probe(id: string, req: { responses: string[] }): Promise<Step> {
    const row = this.row(id);
    const session = row.session as Ev2Session;
    if (req.responses.length !== 4)
      throw new Ntag424Error('NTAG_COMMAND_FAILED', 'The probe is short.');
    for (let n = 1; n <= 4; n++) {
      const body = await checkResponse(
        session,
        row.probes[n - 1] as Sent,
        h(req.responses[n - 1] as string),
      );
      row.old[n] = body[0] === this.plan.version ? (this.plan.keys[n] as Uint8Array) : ZERO16;
    }
    return this.script(row, false);
  }

  /** Checks every response in order, then the read-back as a tap. */
  async result(id: string, req: { responses: string[]; url: string }) {
    const row = this.row(id);
    const session = row.session as Ev2Session;
    if (req.responses.length !== row.script.length)
      throw new Ntag424Error('NTAG_COMMAND_FAILED', 'The script did not finish.');
    for (const [i, e] of row.script.entries()) {
      const raw = h(req.responses[i] as string);
      if (e.kind === 'bare') checkBare(session, raw);
      else await checkResponse(session, e.sent, raw);
    }
    const tap = parseSunUrl(req.url);
    if (!tap) throw new Ntag424Error('NTAG_COMMAND_FAILED', 'The read-back is not a tap.');
    // The Plain write has no MAC, so the read-back is the proof of what the tag holds.
    if (tap.host !== this.plan.host || tap.slug !== this.plan.slug)
      throw new Ntag424Error('NTAG_COMMAND_FAILED', 'The read-back names another URL.');
    const read = await verifySun(
      {
        metaKey: this.plan.keys[1] as Uint8Array,
        fileKey: this.plan.keys[2] as Uint8Array,
        diversified: false,
      },
      tap.p,
      tap.m,
    );
    if (!read.ok) throw new Ntag424Error('NTAG_COMMAND_FAILED', 'The read-back does not verify.');
    row.state = 'programmed';
    return { state: row.state, counter: read.read.counter };
  }

  private async script(row: Row, keyed: boolean): Promise<Step> {
    const s = row.session as Ev2Session;
    const { plan } = this;
    const template = sunTemplate(plan.host, plan.slug);
    const apdus: string[] = [];
    row.script = [];
    const add = (built: { apdu: Uint8Array; sent: Sent }, kind: Expect['kind']) => {
      apdus.push(bytesToHex(built.apdu));
      row.script.push({ sent: built.sent, kind });
    };
    add(await writeData(s, FILE_NDEF, 0, template.file), 'bare');
    add(await changeFileSettings(s, FILE_NDEF, sdmFileSettings(template)), 'mac');
    if (!keyed) {
      for (const n of [1, 2, 3, 4])
        add(
          await changeKey(s, {
            keyNo: n,
            newKey: plan.keys[n] as Uint8Array,
            oldKey: row.old[n] ?? ZERO16,
            version: plan.version,
          }),
          'mac',
        );
      add(
        await changeKey(s, { keyNo: 0, newKey: plan.keys[0] as Uint8Array, version: plan.version }),
        'bare',
      );
    }
    return { next: 'script', apdus, stopOn: '9100' };
  }

  private async part2(row: Row, auth1: Uint8Array): Promise<string> {
    row.rndA = this.random(16);
    const key = this.keyOf(row);
    const p = await authPart2(key, auth1, row.rndA);
    row.rndB = p.rndB;
    return bytesToHex(p.apdu);
  }

  private keyOf = (row: Row) => (row.candidate === 0 ? ZERO16 : (this.plan.keys[0] as Uint8Array));

  private row(id: string): Row {
    for (const row of this.rows.values()) if (row.id === id) return row;
    throw new Ntag424Error('NTAG_COMMAND_FAILED', 'Unknown program.');
  }

  private genuine(uid: Uint8Array, sig: Uint8Array): boolean {
    const id = `${bytesToHex(uid)}${bytesToHex(sig)}`;
    const known = this.seen.get(id);
    if (known !== undefined) return known;
    const ok = verifyUidSignature(this.plan.originalityKey, uid, sig);
    this.seen.set(id, ok);
    return ok;
  }
}
