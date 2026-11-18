import type { Json, Personalization, TemplateManifest, ValidationIssue } from '../types.ts';
import { checkExpr, ExprError, evaluate, exprReferences, isEmpty } from './expr.ts';

export const EMAIL_SUBJECT_MAX = 120;

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `email.subject`: a string of 1 to 120 characters, one line, with expressions that resolve. */
export function emailManifestIssues(manifest: TemplateManifest): ValidationIssue[] {
  if (manifest.email === undefined) return [];
  const bad = (message: string): ValidationIssue[] => [
    { severity: 'error', code: 'EMAIL_SUBJECT', message, path: 'email.subject' },
  ];
  const subject = isRecord(manifest.email) ? manifest.email.subject : undefined;
  if (subject === undefined) return isRecord(manifest.email) ? [] : bad('email must be an object.');
  if (typeof subject !== 'string') return bad('email.subject must be a string.');
  if (/[\r\n]/.test(subject)) return bad('email.subject must be one line.');
  if (subject.trim().length < 1 || subject.length > EMAIL_SUBJECT_MAX)
    return bad(`email.subject must be 1 to ${EMAIL_SUBJECT_MAX} characters.`);
  const problem = checkExpr(subject);
  if (problem) return bad(problem);
  if (/\bpass\./.test(subject)) return bad('email.subject cannot use pass values.');
  const properties = isRecord(manifest.inputs?.properties) ? manifest.inputs.properties : {};
  const refs = exprReferences(subject);
  const unknown = refs.inputs.filter((name) => !Object.hasOwn(properties, name));
  if (unknown.length) return bad(`email.subject uses unknown inputs: ${unknown.join(', ')}.`);
  const tables = manifest.lookups ?? {};
  const missing = refs.lookups.filter((name) => !Object.hasOwn(tables, name));
  if (missing.length) return bad(`email.subject uses unknown lookups: ${missing.join(', ')}.`);
  return [];
}

const CONTROL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u00a0\u00ad\u200b-\u200f\u2028-\u202f\u2060\u2066-\u2069\ufeff]+/gu;

/**
 * The template's subject for this pass, or `fallback` when it sets none, fails to evaluate, or
 * comes out empty. Never carries a line break; capped at 120 characters.
 */
export function renderEmailSubject(
  manifest: Pick<TemplateManifest, 'email' | 'lookups'> | null,
  input: Personalization,
  fallback: string,
): string {
  const template = manifest?.email?.subject;
  if (typeof template !== 'string') return fallback;
  try {
    const value = evaluate(template, { input, lookups: manifest?.lookups ?? {} });
    if (isEmpty(value)) return fallback;
    const line = String(value).replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
    return line ? line.slice(0, EMAIL_SUBJECT_MAX) : fallback;
  } catch (error) {
    // A subject that cannot evaluate (a bad path, too long) falls back to the plain one.
    if (error instanceof ExprError) return fallback;
    throw error;
  }
}
