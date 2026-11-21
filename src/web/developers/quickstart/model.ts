import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { EXAMPLE_IDS } from '../model/ids.ts';
import { samplesFor } from '../model/samples.ts';
import type { CodeLang } from '../playground/hash.ts';
import type { InputValues } from '../playground/model.ts';
import { snippetsFor } from '../playground/snippets.ts';

/** The fields the ticket needs, and nothing else: the request on screen is the request that runs. */
const REQUIRED = [
  'eventName',
  'venueName',
  'venueRegion',
  'startsAt',
  'endsAt',
  'attendee',
  'ticketId',
] as const;

/** The first request's input: the template's own sample, cut to what it requires, with a name of your own. */
export function firstInput(sample: InputValues): InputValues {
  const out: InputValues = {};
  for (const key of REQUIRED) if (sample[key] !== undefined) out[key] = sample[key];
  return { ...out, attendee: 'Casey River', ticketId: 'QS-1042' };
}

export const ADMISSIONS = ['VIP', 'Front row', 'Balcony', 'General'] as const;

export interface Code {
  lang: CodeLang;
  label: string;
  code: string;
}

/** `POST /passes` for the sandbox's ticket, in four languages. */
export const createCode = (templateId: string, input: InputValues, apiBase: string): Code[] =>
  snippetsFor(templateId, input, apiBase);

const LANG_KEY: Record<CodeLang, string> = { ts: 'ts', curl: 'curl', py: 'py', go: 'go' };

/** `PATCH /passes/{id}` with If-Match and a new admission, written for this pass. */
export function patchCode(
  passId: string,
  version: number,
  admission: string,
  apiBase: string,
): Code[] {
  const samples = samplesFor(
    {
      method: 'patch',
      path: '/passes/{id}',
      idempotent: false,
      fields: [],
      binary: false,
      download: false,
      paged: false,
      sdkCall: 'pb.passes.update',
      sample: {
        body: { input: { admission }, notify: true },
        query: {},
        headers: { 'If-Match': `"${version}"` },
      },
    },
    apiBase,
  );
  return (['ts', 'curl', 'py', 'go'] as const).flatMap((lang) => {
    const s = samples.find((x) => x.lang === LANG_KEY[lang]);
    return s ? [{ lang, label: s.label, code: s.code.replaceAll(EXAMPLE_IDS.passId, passId) }] : [];
  });
}

/** 1-based lines worth lighting: the ones that name the input. */
export function litLines(code: string, words: readonly string[]): Set<number> {
  const out = new Set<number>();
  code.split('\n').forEach((line, i) => {
    if (words.some((w) => line.includes(w))) out.add(i + 1);
  });
  return out;
}

export const envFile = (secret: string | null, templateId: string): string =>
  `${secret ? `PASSBOOK_KEY=${secret}\n` : ''}PASSBOOK_TEMPLATE_ID=${templateId}\n`;

/** What the page draws of a key: its start and last four, never the middle. */
export const maskKey = (secret: string): string =>
  `${secret.slice(0, secret.indexOf('_', 5) + 1 || 9)}…${secret.slice(-4)}`;

export interface Problem {
  status: number;
  code: string | undefined;
  detail: string;
}

export interface Fix {
  title: string;
  line: string;
  /** The sandbox's own setup can be finished again: the create call completes what is missing. */
  repair: boolean;
  /** An entry in the errors catalog. */
  code: string | undefined;
}

/** What a failed call says to do, in the page's words; the API's sentence is the title when it is not one the page knows. */
export function fixFor(problem: Problem, hasTemplate: boolean): Fix {
  const f = QS_COPY.fail;
  if (!hasTemplate)
    return { title: f.noTemplate, line: f.noTemplateLine, repair: true, code: problem.code };
  if (problem.code === 'TEMPLATE_RELEASE_REQUIRED')
    return { title: f.noRelease, line: f.noReleaseLine, repair: true, code: problem.code };
  if (problem.status === 0) return { title: f.network, line: '', repair: false, code: undefined };
  if (problem.status === 429)
    return { title: f.limited, line: '', repair: false, code: problem.code };
  return {
    title: problem.detail || f.generic,
    line: '',
    repair: false,
    code: problem.code,
  };
}

export const STATUS_WORD: Record<number, string> = {
  200: 'OK',
  201: 'CREATED',
  400: 'BAD REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT FOUND',
  409: 'CONFLICT',
  412: 'STALE',
  422: 'INVALID',
  429: 'SLOW DOWN',
};

export const stamp = (status: number): string =>
  status === 0
    ? 'NO ANSWER'
    : `${status} ${STATUS_WORD[status] ?? (status >= 500 ? 'ERROR' : 'FAILED')}`;
