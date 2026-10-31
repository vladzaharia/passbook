import type { Json } from '../../../shared/contracts/common.ts';
import { getPointer, isPointer } from '../../connectors/lib/pointer.ts';
import type { UpstreamRecord } from '../../connectors/types.ts';
import { type FieldIssue, ValidationError } from '../../platform/errors.ts';
import type { MappingEntry } from './repo.ts';

const KINDS = ['enum', 'bool-status', 'date', 'constant', 'trim', 'upper', 'lower'] as const;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const DATE_INPUTS = ['auto', 'iso', 'epoch-s', 'epoch-ms'];
const DATE_OUTPUTS = ['iso', 'date', 'epoch-s', 'epoch-ms'];

export function validateMapping(mapping: Record<string, MappingEntry> | null | undefined): void {
  if (!mapping) return;
  const issues: FieldIssue[] = [];
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
      if (o.input !== undefined && !DATE_INPUTS.includes(String(o.input))) {
        issues.push({ path: `${path}.transform`, message: 'Unknown date input.' });
      }
      if (o.output !== undefined && !DATE_OUTPUTS.includes(String(o.output))) {
        issues.push({ path: `${path}.transform`, message: 'Unknown date output.' });
      }
    }
  }
  if (issues.length) throw new ValidationError('The mapping is invalid.', issues);
}

function truthy(value: Json): boolean {
  if (typeof value === 'string')
    return ['true', '1', 'yes', 'y', 'active'].includes(value.toLowerCase());
  return value === true || value === 1;
}

function toMillis(value: Json, input: string): number | null {
  let ms: number;
  if (typeof value === 'number') {
    ms = input === 'epoch-s' || (input === 'auto' && Math.abs(value) < 1e11) ? value * 1000 : value;
  } else if (typeof value === 'string') {
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

function transform(value: Json | undefined, entry: MappingEntry): Json | undefined {
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

/** Template input <- upstream field. Without a mapping the record passes through unchanged. */
export function applyMapping(
  mapping: Record<string, MappingEntry> | null,
  record: UpstreamRecord,
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
