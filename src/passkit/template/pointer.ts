import type { Json, PassJson } from '../types.ts';

export const BINDING_STYLE_GROUPS = {
  styles: ['generic', 'posterGeneric', 'storeCard', 'coupon', 'eventTicket', 'boardingPass'],
  groups: [
    'headerFields',
    'primaryFields',
    'secondaryFields',
    'auxiliaryFields',
    'footerFields',
    'backFields',
    'additionalInfoFields',
  ],
} as const;

/** Owned by the server or by dedicated binding targets; pointers may never reach them. */
const DENIED_ROOTS = new Set([
  'formatVersion',
  'passTypeIdentifier',
  'teamIdentifier',
  'serialNumber',
  'organizationName',
  'webServiceURL',
  'authenticationToken',
  'barcode',
  'barcodes',
  'featuredActions',
  'generic',
  'posterGeneric',
  'storeCard',
  'coupon',
  'eventTicket',
  'boardingPass',
]);
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype', '_id']);
/** The only places a pointer may enter a style dictionary. */
const STYLE_SCALARS = new Set(['transitType']);

export function parsePointer(pointer: string): string[] | null {
  if (pointer === '' || !pointer.startsWith('/')) return null;
  return pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Returns the problem, or null when the pointer is allowed. */
export function isAllowedPointer(pointer: string): string | null {
  const tokens = parsePointer(pointer);
  if (!tokens) return `Pointer "${pointer}" must start with "/".`;
  if (tokens.length > 6) return `Pointer "${pointer}" is too deep.`;
  if (tokens.some((t) => BLOCKED.has(t) || t === '')) return `Pointer "${pointer}" is not allowed.`;
  const [root, second] = tokens as [string, string?];
  const isStyle = (BINDING_STYLE_GROUPS.styles as readonly string[]).includes(root);
  if (isStyle) {
    return tokens.length === 2 && STYLE_SCALARS.has(second ?? '')
      ? null
      : `Pointer "${pointer}": use a field target for style dictionaries.`;
  }
  if (DENIED_ROOTS.has(root)) return `Pointer "${pointer}" targets a protected key.`;
  return null;
}

type Container = Record<string, unknown> | unknown[];

function step(node: Container, token: string): unknown {
  if (Array.isArray(node)) {
    const index = Number(token);
    return Number.isInteger(index) ? node[index] : undefined;
  }
  return Object.hasOwn(node, token) ? node[token] : undefined;
}

/** Sets the value, creating plain objects for missing parents. Returns false when it cannot. */
export function setPointer(pass: PassJson, pointer: string, value: Json): boolean {
  const tokens = parsePointer(pointer);
  if (!tokens) return false;
  let node: Container = pass;
  for (const token of tokens.slice(0, -1)) {
    let next = step(node, token);
    if (next === undefined) {
      if (Array.isArray(node)) return false;
      next = {};
      node[token] = next;
    }
    if (typeof next !== 'object' || next === null) return false;
    node = next as Container;
  }
  const last = tokens[tokens.length - 1] as string;
  if (Array.isArray(node)) {
    const index = last === '-' ? node.length : Number(last);
    if (!Number.isInteger(index) || index < 0 || index > node.length) return false;
    node[index] = value;
  } else node[last] = value;
  return true;
}

export function deletePointer(pass: PassJson, pointer: string): void {
  const tokens = parsePointer(pointer);
  if (!tokens) return;
  let node: unknown = pass;
  for (const token of tokens.slice(0, -1)) {
    if (typeof node !== 'object' || node === null) return;
    node = step(node as Container, token);
  }
  if (typeof node !== 'object' || node === null) return;
  const last = tokens[tokens.length - 1] as string;
  if (Array.isArray(node)) {
    const index = Number(last);
    if (Number.isInteger(index) && index >= 0 && index < node.length) node.splice(index, 1);
  } else delete (node as Record<string, unknown>)[last];
}
