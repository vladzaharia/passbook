import type { Json } from '../contracts/common.ts';
import { getPointer, isPointer } from './pointer.ts';

export interface MappingEntry {
  from: string;
  transform?: { kind: string; options?: Record<string, Json> | undefined } | undefined;
}

export interface MappingIssue {
  path: string;
  message: string;
}

export const KINDS = ['enum', 'bool-status', 'date', 'constant', 'trim', 'upper', 'lower'] as const;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
export const DATE_INPUTS = ['auto', 'iso', 'epoch-s', 'epoch-ms', 'dmy', 'mdy', 'ymd'] as const;
const DATE_OUTPUTS = ['iso', 'date', 'epoch-s', 'epoch-ms'];

/** Structural checks only; the caller decides how to report them. */
export function mappingIssues(
  mapping: Record<string, MappingEntry> | null | undefined,
): MappingIssue[] {
  const issues: MappingIssue[] = [];
  if (!mapping) return issues;
  for (const [field, entry] of Object.entries(mapping)) {
    const path = `mapping.${field}`;
    if (!FIELD.test(field) || RESERVED.has(field)) {
      issues.push({ path, message: 'Invalid field name.' });
    }
    const kind = entry.transform?.kind;
    if (kind !== 'constant' && !isPointer(entry.from)) {
      issues.push({ path: `${path}.from`, message: 'Not a JSON pointer.' });
    }
    if (!kind) continue;
    if (!(KINDS as readonly string[]).includes(kind)) {
      issues.push({ path: `${path}.transform`, message: 'Unknown transform.' });
    }
    const o = entry.transform?.options ?? {};
    if (kind === 'enum' && (typeof o.map !== 'object' || o.map === null || Array.isArray(o.map))) {
      issues.push({ path: `${path}.transform`, message: 'enum needs options.map.' });
    }
    if (kind === 'constant' && !('value' in o)) {
      issues.push({ path: `${path}.transform`, message: 'constant needs options.value.' });
    }
    if (kind === 'date') {
      if (o.input !== undefined && !(DATE_INPUTS as readonly string[]).includes(String(o.input))) {
        issues.push({ path: `${path}.transform`, message: 'Unknown date input.' });
      }
      if (o.output !== undefined && !DATE_OUTPUTS.includes(String(o.output))) {
        issues.push({ path: `${path}.transform`, message: 'Unknown date output.' });
      }
    }
  }
  return issues;
}

export function truthy(value: Json): boolean {
  if (typeof value === 'string')
    return ['true', '1', 'yes', 'y', 'active'].includes(value.toLowerCase());
  return value === true || value === 1;
}

const PARTS = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** UTC milliseconds for day-first, month-first or year-first text; null when not a real date. */
function parseParts(text: string, input: 'dmy' | 'mdy' | 'ymd'): number | null {
  const m = PARTS.exec(text.trim());
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [y, mo, d] = input === 'dmy' ? [c, b, a] : input === 'mdy' ? [c, a, b] : [a, b, c];
  if (String(input === 'ymd' ? m[1] : m[3]).length !== 4) return null;
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d
    ? ms
    : null;
}

function toMillis(value: Json, input: string): number | null {
  let ms: number;
  if (typeof value === 'number') {
    ms = input === 'epoch-s' || (input === 'auto' && Math.abs(value) < 1e11) ? value * 1000 : value;
  } else if (typeof value === 'string') {
    if (input === 'dmy' || input === 'mdy' || input === 'ymd') return parseParts(value, input);
    ms =
      /^-?\d+$/.test(value) && input !== 'iso'
        ? (toMillis(Number(value), input) ?? Number.NaN)
        : Date.parse(value);
  } else {
    return null;
  }
  return Number.isFinite(ms) ? ms : null;
}

function formatDate(value: Json, o: Record<string, Json>): Json | undefined {
  const ms = toMillis(value, String(o.input ?? 'auto'));
  if (ms === null) return undefined;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  switch (o.output ?? 'iso') {
    case 'date':
      return date.toISOString().slice(0, 10);
    case 'epoch-ms':
      return ms;
    case 'epoch-s':
      return Math.floor(ms / 1000);
    default:
      return date.toISOString();
  }
}

export function transform(value: Json | undefined, entry: MappingEntry): Json | undefined {
  const t = entry.transform;
  const o = t?.options ?? {};
  if (t?.kind === 'constant') return o.value;
  if (value === undefined || value === null) return undefined;
  switch (t?.kind) {
    case 'enum': {
      const map = o.map as Record<string, Json>;
      const key = String(value);
      return Object.hasOwn(map, key) ? map[key] : o.default;
    }
    case 'bool-status':
      return truthy(value) ? (o.true ?? 'active') : (o.false ?? 'inactive');
    case 'date':
      return formatDate(value, o);
    case 'trim':
      return typeof value === 'string' ? value.trim() : value;
    case 'upper':
      return typeof value === 'string' ? value.toUpperCase() : value;
    case 'lower':
      return typeof value === 'string' ? value.toLowerCase() : value;
    default:
      return value;
  }
}

/** Template input <- source field. Without a mapping the record passes through unchanged. */
export function applyMapping(
  mapping: Record<string, MappingEntry> | null,
  record: Record<string, Json>,
): Record<string, Json> {
  if (!mapping) return { ...record };
  const out: Record<string, Json> = {};
  for (const [field, entry] of Object.entries(mapping)) {
    if (RESERVED.has(field)) continue;
    const value = transform(getPointer(record, entry.from), entry);
    if (value !== undefined && value !== null) out[field] = value;
  }
  return out;
}
