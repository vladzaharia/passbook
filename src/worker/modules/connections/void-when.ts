import type { VoidRule } from '../../../shared/contracts/connections.ts';
import { getPointer, isPointer } from '../../connectors/lib/pointer.ts';
import type { UpstreamRecord } from '../../connectors/types.ts';
import { ValidationError } from '../../platform/errors.ts';

const MAX_RULES = 8;
const MAX_VALUES = 20;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

const scalar = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v);

/** Issue paths read `voidWhen.<index>.<field>`, like validateMapping's. */
export function voidWhenIssues(rules: readonly VoidRule[]): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (rules.length > MAX_RULES) issues.push({ path: 'voidWhen', message: 'At most 8 rules.' });
  rules.forEach((rule, i) => {
    const at = `voidWhen.${i}`;
    if (!isPointer(rule.from) || rule.from.split('/').some((s) => RESERVED.has(s))) {
      issues.push({ path: `${at}.from`, message: 'Not a JSON pointer.' });
    }
    if (rule.op !== 'in' && rule.op !== 'present') {
      issues.push({ path: `${at}.op`, message: 'Unknown operator.' });
    } else if (rule.op === 'in') {
      const values: unknown = rule.values;
      if (!Array.isArray(values) || values.length === 0 || values.length > MAX_VALUES) {
        issues.push({ path: `${at}.values`, message: 'One to 20 values.' });
      } else if (!values.every(scalar)) {
        issues.push({ path: `${at}.values`, message: 'Text, numbers or true/false only.' });
      }
    } else if (rule.values !== undefined) {
      issues.push({ path: `${at}.values`, message: 'Only "is one of" takes values.' });
    }
  });
  return issues;
}

export function validateVoidWhen(rules: readonly VoidRule[]): void {
  const issues = voidWhenIssues(rules);
  if (issues.length) throw new ValidationError('The void rules are invalid.', issues);
}

/**
 * True when any rule matches the upstream record (rules are OR'ed). `present`: the field exists and is
 * neither null nor an empty string (0 and false are present). `in`: strict equality, exact case.
 */
export function matchesVoidWhen(rules: readonly VoidRule[], record: UpstreamRecord): boolean {
  return rules.some((rule) => {
    const value = getPointer(record, rule.from);
    if (rule.op === 'present') return value !== undefined && value !== null && value !== '';
    return (rule.values ?? []).some((v) => v === value);
  });
}
