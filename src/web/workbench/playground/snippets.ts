import { samplesFor } from '../../developers/model/samples.ts';
import type { CodeLang } from './hash.ts';
import type { InputValues } from './model.ts';

const LANG_OF: Record<CodeLang, string> = { ts: 'ts', curl: 'curl', py: 'py', go: 'go' };
const ORDER: readonly CodeLang[] = ['ts', 'curl', 'py', 'go'];

export interface Snippet {
  lang: CodeLang;
  label: string;
  code: string;
}

/** `POST /passes` for this template and input, in the portal's four languages. The key is never in it. */
export function snippetsFor(templateId: string, input: InputValues, apiBase: string): Snippet[] {
  const samples = samplesFor(
    {
      method: 'post',
      path: '/passes',
      idempotent: true,
      fields: [],
      binary: false,
      download: false,
      paged: false,
      sdkCall: 'pb.passes.create',
      sample: { body: { templateId, input } as never, query: {}, headers: {} },
    },
    apiBase,
  );
  return ORDER.flatMap((lang) => {
    const s = samples.find((x) => x.lang === LANG_OF[lang]);
    return s ? [{ lang, label: s.label, code: s.code }] : [];
  });
}

/**
 * The lines of `next` that were not in `prev` (1-based): the ones a person's edit changed. A line
 * that moved is not a change; a repeated line counts once per occurrence.
 */
export function changedLines(prev: string, next: string): number[] {
  const seen = new Map<string, number>();
  for (const line of prev.split('\n')) seen.set(line, (seen.get(line) ?? 0) + 1);
  const out: number[] = [];
  next.split('\n').forEach((line, i) => {
    const left = seen.get(line) ?? 0;
    if (left > 0) seen.set(line, left - 1);
    else out.push(i + 1);
  });
  return out;
}
