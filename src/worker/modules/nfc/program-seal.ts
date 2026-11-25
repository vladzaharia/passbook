import {
  credentialAad,
  decryptSecret,
  type Envelope,
  encryptSecret,
  type KekRing,
} from '../../platform/crypto.ts';
import { KEY_BYTES, type KeyScope, unreadable } from './keyset-seal.ts';
import { bytesToHex, hexToBytes } from './sun.ts';

/**
 * Programming keys and sessions at rest, in the platform envelope (`platform/crypto.ts`), bound by AAD to the
 * program (or tag), org, mode and keyset. The intended keys and the admin keys are places of cron keys.rewrap
 * (rewrap-tables.ts); the session is not: it lives a minute, is deleted in every state but started and scripted,
 * and a session that cannot be opened after a KEK retires just fails that hold.
 */
export const programKind = (mode: string, keysetId: string) =>
  `nfc_tag_program:${mode}:${keysetId}`;
export const sessionKind = (mode: string, keysetId: string) =>
  `nfc_tag_program_session:${mode}:${keysetId}`;
export const adminKind = (mode: string, keysetId: string) => `nfc_tag_admin:${mode}:${keysetId}`;

/** K0 to K4: the tag's five application keys. */
export const KEY_COUNT = 5;

/** What one command of a script expects back: a MAC'd answer, or a bare 9100 (plain write, ChangeKey of key 0). */
export interface Expect {
  ctr: number;
  kind: 'mac' | 'bare';
}

/** What the server asked the device to do next, kept so a repeated call gets the same answer. */
export type Next =
  | { next: 'probe' | 'script'; apdus: string[]; stopOn: '9100' }
  | { next: 'reauth'; apdus: string[] };

/** The state of one hold between calls. Hex strings: it is JSON, sealed. */
export interface SessionState {
  /** The actor key of the device holding this hold: only it may continue it. */
  by: string;
  /** The start's idempotency key, so a retried start gets the same answer. */
  idem: string;
  /** 0: the factory key tried first; 1: the intended K0, after a refusal. */
  candidate: 0 | 1;
  auth1: string;
  rndA: string;
  rndB: string;
  part2: string;
  ses?: { enc: string; mac: string; ti: string; ctr: number };
  authAnswer?: string;
  authStep?: Next;
  probes?: number[];
  probeAnswer?: string[];
  scriptStep?: Next;
  /** The keys now in slots 1 to 4, from the probe (index 0 is key 1). */
  old?: string[];
  expect?: Expect[];
}

const aadOf = (id: string, s: KeyScope, kind: string) => credentialAad(id, s.orgId, kind);

async function open(ring: KekRing, e: Envelope, aad: string): Promise<Uint8Array> {
  try {
    return await decryptSecret(ring, e, aad);
  } catch {
    throw unreadable();
  }
}

/** K0 || K1 || K2 || K3 || K4. */
export function sealIntended(ring: KekRing, s: KeyScope, programId: string, keys: Uint8Array[]) {
  if (keys.length !== KEY_COUNT || keys.some((k) => k.length !== KEY_BYTES)) throw unreadable();
  const all = new Uint8Array(KEY_COUNT * KEY_BYTES);
  keys.forEach((k, i) => {
    all.set(k, i * KEY_BYTES);
  });
  return encryptSecret(ring, all, aadOf(programId, s, programKind(s.mode, s.keysetId)));
}

export async function openIntended(
  ring: KekRing,
  s: KeyScope,
  programId: string,
  e: Envelope,
): Promise<Uint8Array[]> {
  const all = await open(ring, e, aadOf(programId, s, programKind(s.mode, s.keysetId)));
  if (all.length !== KEY_COUNT * KEY_BYTES) throw unreadable();
  return Array.from({ length: KEY_COUNT }, (_, i) => all.slice(i * KEY_BYTES, (i + 1) * KEY_BYTES));
}

export const sealSession = (ring: KekRing, s: KeyScope, programId: string, state: SessionState) =>
  encryptSecret(
    ring,
    new TextEncoder().encode(JSON.stringify(state)),
    aadOf(programId, s, sessionKind(s.mode, s.keysetId)),
  );

export async function openSession(
  ring: KekRing,
  s: KeyScope,
  programId: string,
  e: Envelope,
): Promise<SessionState> {
  const plain = await open(ring, e, aadOf(programId, s, sessionKind(s.mode, s.keysetId)));
  try {
    return JSON.parse(new TextDecoder().decode(plain)) as SessionState;
  } catch {
    throw unreadable();
  }
}

/** K0 || K3 || K4, bound to the tag. */
export function sealAdmin(ring: KekRing, s: KeyScope, tagId: string, keys: Uint8Array[]) {
  const [k0, , , k3, k4] = keys;
  if (!k0 || !k3 || !k4) throw unreadable();
  const all = new Uint8Array(KEY_BYTES * 3);
  all.set(k0);
  all.set(k3, KEY_BYTES);
  all.set(k4, KEY_BYTES * 2);
  return encryptSecret(ring, all, aadOf(tagId, s, adminKind(s.mode, s.keysetId)));
}

export async function openAdmin(ring: KekRing, s: KeyScope, tagId: string, e: Envelope) {
  const all = await open(ring, e, aadOf(tagId, s, adminKind(s.mode, s.keysetId)));
  if (all.length !== KEY_BYTES * 3) throw unreadable();
  return {
    k0: all.slice(0, KEY_BYTES),
    k3: all.slice(KEY_BYTES, KEY_BYTES * 2),
    k4: all.slice(KEY_BYTES * 2),
  };
}

export const hex = bytesToHex;
export const unhex = (s: string): Uint8Array => hexToBytes(s) ?? new Uint8Array(0);
