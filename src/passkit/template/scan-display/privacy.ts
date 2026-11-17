/**
 * The one scanner privacy policy, shared by the Worker (what a role may see) and the designer
 * preview. Pure: no Worker or DOM imports. Visibility comes from provenance (the input schema,
 * `x-scan`, bindings; see `scope.ts`), never from what a value looks like. The only value check is
 * a denylist of real secrets (scan code, barcode message, tokens), and only for 6+ characters:
 * shorter strings collide with ordinary text, and a leaf that is not a secret has a source that
 * provenance already judged.
 */
import { nameSegments } from './scope.ts';

export const SECRET_MIN_LENGTH = 6;

/** Shown when a stop flag the scanner may not read still holds the check-in. */
export const HIDDEN_STOP_LABEL = 'Check required';

const PRIVATE_SEGMENTS = new Set([
  'email',
  'phone',
  'tel',
  'mobile',
  'address',
  'contact',
  'password',
  'passcode',
  'secret',
  'token',
  'pin',
  'barcode',
  'nfc',
  'serial',
  'private',
  'credential',
  'authorization',
  'cookie',
]);
const PRIVATE_KEYS = new Set([
  'apikey',
  'barcodes',
  'scancode',
  'serialnumber',
  'webserviceurl',
  'messageencoding',
  'proto',
  'constructor',
  'prototype',
]);

/** A name no role may read, whatever the author annotated: contacts, credentials, wallet internals. */
export function isPrivateName(name: string): boolean {
  return (
    PRIVATE_KEYS.has(name.replace(/[^a-z0-9]/gi, '').toLowerCase()) ||
    nameSegments(name).some((segment) => PRIVATE_SEGMENTS.has(segment))
  );
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*/iu;
const URL_LIKE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:|www\.)/i;

/** An address or link is never display text. Phone numbers are not guessed at: see the header. */
export function hasContactShape(text: string): boolean {
  return EMAIL.test(text) || URL_LIKE.test(text);
}

// The web tsconfig's lib predates String.prototype.toWellFormed; every runtime we ship has it.
const wellFormed = (value: string): string =>
  (value as string & { toWellFormed(): string }).toWellFormed();

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * The spellings under which a secret can reach text: as stored, HTML-escaped (bindings can escape)
 * and URL-encoded. Strings and numbers under {@link SECRET_MIN_LENGTH} characters are skipped.
 */
export function secretSpellings(...parts: unknown[]): string[] {
  const out = new Set<string>();
  const add = (value: string) => {
    if (value.length < SECRET_MIN_LENGTH) return;
    out.add(value);
    if (/[&<>"']/.test(value)) out.add(escapeHtml(value));
    if (/[^A-Za-z0-9_.!~*'()-]/.test(value)) out.add(encodeURIComponent(wellFormed(value)));
  };
  const visit = (part: unknown): void => {
    if (typeof part === 'string') add(part);
    else if (typeof part === 'number' && Number.isFinite(part)) add(String(part));
    else if (Array.isArray(part)) part.forEach(visit);
    else if (part && typeof part === 'object') Object.values(part).forEach(visit);
  };
  parts.forEach(visit);
  return [...out];
}

/** Whether a leaf discloses a secret: text contains one; a number or boolean is one. */
export function leaksSecret(value: unknown, spellings: readonly string[]): boolean {
  if (typeof value === 'string') return spellings.some((secret) => value.includes(secret));
  if (typeof value === 'number') return spellings.includes(String(value));
  return false;
}
