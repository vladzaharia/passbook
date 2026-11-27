import { CONSOLE_COPY } from '../../../shared/copy/developers-bench-console.ts';
import type { Outcome } from './send.ts';
import type { Json, RunOp } from './types.ts';

/** What the buddy does at the response header: a create went through, or a call failed. */
export type Moment = { kind: 'cheer' | 'sorry'; caption: string | null };

const isObject = (v: Json | undefined): v is Record<string, Json> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The problem's first issue as one line: what to fix. Falls back to its detail. */
export function firstIssue(json: Json | undefined): string | null {
  if (!isObject(json)) return null;
  const issue = Array.isArray(json.issues) ? json.issues[0] : undefined;
  if (typeof issue === 'string') return issue;
  if (isObject(issue) && typeof issue.message === 'string')
    return typeof issue.path === 'string' && issue.path
      ? `${issue.path} ${issue.message}`
      : issue.message;
  return typeof json.detail === 'string' ? json.detail : null;
}

/** A 2xx create cheers (the first pass is "Pass issued"); a 4xx or 5xx is sorry, with what to fix. */
export function momentOf(op: RunOp, o: Outcome): Moment | null {
  if (o.status >= 400) return { kind: 'sorry', caption: firstIssue(o.json) };
  if (o.status >= 200 && o.status < 300 && op.method === 'post' && /\.create$/.test(op.sdk.call))
    return {
      kind: 'cheer',
      caption: op.sdk.call === 'pb.passes.create' ? CONSOLE_COPY.issued : CONSOLE_COPY.created,
    };
  return null;
}
