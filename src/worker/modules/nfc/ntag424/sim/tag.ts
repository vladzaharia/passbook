import { cbcDecrypt, cbcEncrypt } from '../aes.ts';
import { concat, ZERO16 } from '../bytes.ts';
import { deriveSessionKeys, type Ev2Session } from '../ev2.ts';
import { toInt } from '../p224.ts';
import { secureCommand } from './commands.ts';
import { isoCommand } from './iso.ts';
import { ecdsaSign, encodeSignature, publicPoint } from './sign.ts';
import { blankTag, type SimTag, status, TagLostError } from './state.ts';

/** A test-only originality key pair: stands in for NXP's, whose private half no one outside NXP holds. */
const SIGNING_KEY = 0x1d2c3b4a59687786950a1b2c3d4e5f60718293a4b5c6d7e8f9011223n;
export const SIM_ORIGINALITY_KEY = publicPoint(SIGNING_KEY);
const SIGNING_NONCE = 0x0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbn;

const HW = [0x04, 0x04, 0x08, 0x30, 0x00, 0x11, 0x05];
const SW_VERSION = [0x04, 0x04, 0x02, 0x01, 0x01, 0x11, 0x05];
const BATCH = [0xcd, 0x65, 0x93, 0x5d, 0x40, 0x21, 0x18];

const AUTH_ERROR = 0x91ae;
const rotl = (b: Uint8Array) => concat(b.slice(1), b.slice(0, 1));
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export interface SimOptions {
  uid?: Uint8Array;
  /** Source of RndB, TI and PICCData padding; a counter-based one makes a run reproducible. */
  random?: (n: number) => Uint8Array;
  /** An ISO command inside an authenticated state ends the session (unverified on silicon; AN12196 itself mixes them). */
  endSessionOnIso?: boolean;
}

/**
 * A software NTAG 424 DNA (AES mode) for tests: the commands a Secure-tag program needs, with the factory
 * state, key checks, atomic key changes and the SUN output of a read. It can lose the tag after any command.
 */
export class Ntag424Sim {
  readonly tag: SimTag;
  readonly signature: Uint8Array;
  private readonly random: (n: number) => Uint8Array;
  private count = 0;
  /** `CLA << 8 | INS` of every command received, in order. */
  readonly trace: number[] = [];
  private tear: { at: number; phase: 'before' | 'after' } | null = null;
  private torn = false;
  private readonly endOnIso: boolean;

  constructor(options: SimOptions = {}) {
    this.random = options.random ?? randomBytes;
    this.endOnIso = options.endSessionOnIso === true;
    this.tag = blankTag(options.uid ?? new Uint8Array([0x04, 0x51, 0x8d, 0xfa, 0xa9, 0x61, 0x80]));
    const { r, s } = ecdsaSign(SIGNING_KEY, toInt(this.tag.uid), SIGNING_NONCE);
    this.signature = encodeSignature(r, s);
  }

  /** Commands received so far, torn ones included. */
  get commands(): number {
    return this.count;
  }

  /**
   * Loses the tag at command number `at` (1-based, counted over the tag's life): `after` applies the command
   * and drops the answer, `before` drops the command unapplied.
   */
  tearAt(at: number, phase: 'before' | 'after' = 'after'): void {
    this.tear = { at, phase };
  }

  /** The tag is presented again: the field restarts, so no session, selection or challenge survives. */
  reattach(): void {
    this.torn = false;
    this.tear = null;
    Object.assign(this.tag, {
      selectedApp: false,
      selectedFile: null,
      chain: null,
      pending: null,
      session: null,
    });
  }

  async transceive(apdu: Uint8Array): Promise<Uint8Array> {
    if (this.torn) throw new TagLostError();
    this.count += 1;
    this.trace.push(((apdu[0] as number) << 8) | (apdu[1] as number));
    const tear = this.tear?.at === this.count ? this.tear.phase : null;
    if (tear === 'before') this.lose();
    const answer = await this.dispatch(apdu);
    if (tear === 'after') this.lose();
    return answer;
  }

  private lose(): never {
    this.torn = true;
    throw new TagLostError();
  }

  /** Any native answer other than 9100 (or 91AF, more to come) ends the authenticated state. */
  private async dispatch(apdu: Uint8Array): Promise<Uint8Array> {
    const answer = await this.run(apdu);
    if (apdu[0] === 0x90) {
      const sw =
        ((answer[answer.length - 2] as number) << 8) | (answer[answer.length - 1] as number);
      if (sw !== 0x9100 && sw !== 0x91af) {
        this.tag.session = null;
        this.tag.pending = null;
      }
    }
    return answer;
  }

  private async run(apdu: Uint8Array): Promise<Uint8Array> {
    const [cla, ins, p1, p2] = apdu as unknown as [number, number, number, number];
    // An ISO command inside an authenticated state is unverified on silicon: the simulator ends the session.
    if (cla === 0x00 && this.endOnIso) this.tag.session = null;
    if (cla === 0x00) return isoCommand(this.tag, ins, p1, p2, apdu, this.random);
    if (cla !== 0x90) return status(0x6e00);
    const body = apdu.length > 5 ? apdu.slice(5, 5 + (apdu[4] as number)) : new Uint8Array(0);
    const chain = this.tag.chain;
    this.tag.chain = null;
    switch (ins) {
      case 0x60:
        this.tag.chain = 'version1';
        return status(0x91af, new Uint8Array(HW));
      case 0xaf:
        return this.additional(chain, body);
      case 0x3c:
        return status(0x9100, this.signature);
      case 0x71:
        return this.authFirst(body, false);
      case 0x77:
        return this.authFirst(body, true);
      case 0xf5:
      case 0x64:
      case 0x5f:
      case 0x8d:
      case 0xc4:
        return secureCommand(this.tag, ins, body);
      default:
        return status(0x911c);
    }
  }

  private async additional(chain: SimTag['chain'], body: Uint8Array): Promise<Uint8Array> {
    if (chain === 'version1') {
      this.tag.chain = 'version2';
      return status(0x91af, new Uint8Array(SW_VERSION));
    }
    if (chain === 'version2') return status(0x9100, concat(this.tag.uid, new Uint8Array(BATCH)));
    if (chain === 'auth') return this.authSecond(body);
    return status(0x91ca);
  }

  private async authFirst(body: Uint8Array, nonFirst: boolean): Promise<Uint8Array> {
    const keyNo = body[0] as number;
    if (nonFirst ? !this.tag.session : false) return status(AUTH_ERROR);
    if (!nonFirst) this.tag.session = null;
    if (body.length < (nonFirst ? 1 : 2) || keyNo > 4) return status(0x9140);
    const rndB = this.random(16);
    this.tag.pending = { keyNo, rndB, nonFirst };
    this.tag.chain = 'auth';
    return status(0x91af, await cbcEncrypt(this.tag.keys[keyNo] as Uint8Array, ZERO16, rndB));
  }

  private async authSecond(body: Uint8Array): Promise<Uint8Array> {
    const pending = this.tag.pending;
    this.tag.pending = null;
    if (!pending || body.length !== 32) return status(0x91ca);
    const key = this.tag.keys[pending.keyNo] as Uint8Array;
    const plain = await cbcDecrypt(key, ZERO16, body);
    const rndA = plain.slice(0, 16);
    if (!same(plain.slice(16), rotl(pending.rndB))) return status(AUTH_ERROR);
    const { encKey, macKey } = await deriveSessionKeys(key, rndA, pending.rndB);
    if (pending.nonFirst) {
      // EV2NonFirst keeps the transaction id and the counter; only the keys are new.
      const kept = this.tag.session as Ev2Session;
      this.tag.session = { ...kept, keyNo: pending.keyNo, encKey, macKey };
      return status(0x9100, await cbcEncrypt(key, ZERO16, rotl(rndA)));
    }
    const ti = this.random(4);
    this.tag.session = { keyNo: pending.keyNo, ti, encKey, macKey, ctr: 0, dead: false };
    return status(
      0x9100,
      await cbcEncrypt(key, ZERO16, concat(ti, rotl(rndA), new Uint8Array(12))),
    );
  }
}
