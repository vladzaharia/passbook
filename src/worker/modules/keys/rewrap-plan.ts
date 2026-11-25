import { type KekRing, rewrapSecret } from '../../platform/crypto.ts';
import { fromBase64, toBase64 } from '../../platform/ids.ts';
import type { Move } from './repo-rewrap.ts';
import type { CaptureMove, RawCapture } from './repo-rewrap-captures.ts';
import { captureAad, type Raw } from './rewrap-tables.ts';

const EMPTY = new Uint8Array(0);

const bytes = (value: ArrayBuffer | number[]): Uint8Array =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value);

export interface Plan<M> {
  moves: M[];
  unreadable: string[];
}

/** Rewraps the DEK of each row; a row whose AAD does not open (wrong org, damaged) is left and counted. */
export async function planPlace(
  ring: KekRing,
  aad: (row: Raw) => string,
  rows: Raw[],
): Promise<Plan<Move>> {
  const plan: Plan<Move> = { moves: [], unreadable: [] };
  for (const row of rows) {
    const wrapped = bytes(row.wrapped_dek);
    try {
      const next = await rewrapSecret(
        ring,
        { kekVersion: row.kek_version, iv: EMPTY, wrappedDek: wrapped, ciphertext: EMPTY },
        aad(row),
      );
      plan.moves.push({
        pk: row.pk,
        kek: row.kek_version,
        wrapped,
        nextKek: next.kekVersion,
        nextWrapped: next.wrappedDek,
      });
    } catch {
      plan.unreadable.push(row.pk);
    }
  }
  return plan;
}

/** `enc1:<kek>.<iv>.<wrapped DEK>.` of a sealed body, and the same under the current KEK. */
async function captureHead(
  ring: KekRing,
  head: string | null,
  aad: string,
): Promise<{ from: string; to: string }> {
  const none = { from: '', to: '' };
  if (head === null) return none;
  const m = /^enc1:(\d+)\.([^.]+)\.([^.]+)\./.exec(head);
  if (!m) throw new Error('capture header');
  const kek = Number(m[1]);
  if (kek >= ring.current) return none;
  const next = await rewrapSecret(
    ring,
    { kekVersion: kek, iv: EMPTY, wrappedDek: fromBase64(m[3] ?? ''), ciphertext: EMPTY },
    aad,
  );
  return { from: m[0], to: `enc1:${ring.current}.${m[2]}.${toBase64(next.wrappedDek)}.` };
}

export async function planCaptures(ring: KekRing, rows: RawCapture[]): Promise<Plan<CaptureMove>> {
  const plan: Plan<CaptureMove> = { moves: [], unreadable: [] };
  for (const row of rows) {
    try {
      const aad = captureAad(row.pk, row.org_id);
      const html = await captureHead(ring, row.html, aad);
      const text = await captureHead(ring, row.text, aad);
      if (html.from === '' && text.from === '') throw new Error('nothing to move');
      plan.moves.push({ pk: row.pk, html, text });
    } catch {
      plan.unreadable.push(row.pk);
    }
  }
  return plan;
}
