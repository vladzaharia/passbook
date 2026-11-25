import type { FieldIssue } from '../../platform/errors.ts';

const REQUIRED = /^Instance does not have required property "(.+)"\.$/;

/** A build report's error as an API issue. Input problems sit under `input.`, a missing field named by its full location. */
export function buildIssue(i: { path?: string; message: string; code: string }): FieldIssue {
  if (i.code !== 'INPUT') return { path: i.path ?? '', message: i.message, code: i.code };
  const field = REQUIRED.exec(i.message)?.[1];
  const at = [i.path, field].filter(Boolean).join('/');
  return {
    path: at ? `input.${at}` : 'input',
    message: field ? `${at} is required.` : i.message,
    code: i.code,
  };
}
