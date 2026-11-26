import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { EXAMPLE_IDS } from '../../developers/model/ids.ts';
import { samplesFor } from '../../developers/model/samples.ts';
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

/** The input field the quickstart ticket needs that the call's own request body does not carry. */
function missingField(requestBody: string | null, sample: InputValues | null): string | null {
  if (!sample) return null;
  try {
    const sent = (JSON.parse(requestBody ?? '') as { input?: Record<string, unknown> }).input;
    if (!sent || typeof sent !== 'object') return null;
    return Object.keys(sample).find((k) => !(k in sent)) ?? null;
  } catch {
    // No readable request body: the problem's own words stand.
    return null;
  }
}

/**
 * What a failed call heard in the request log says to do. The log keeps the problem's issue list (path and message
 * per field) but blanks the request's input, so the field is the one the issue names, or else the one the quickstart's
 * input has and the request's body lacks; the title is the problem's own sentence.
 */
export function fixOfCall(
  entry: { status: number; code: string | null },
  bodies: { response: string | null; request: string | null },
  sample: InputValues | null,
): Fix & { path: string | null } {
  let title: string = QS_COPY.fail.generic;
  let path: string | null = null;
  let named = false;
  try {
    const p = JSON.parse(bodies.response ?? '') as {
      detail?: unknown;
      issues?: { path?: unknown; message?: unknown }[];
    };
    if (typeof p.detail === 'string' && p.detail !== '[redacted]') title = p.detail;
    const first = p.issues?.[0]?.path;
    if (typeof first === 'string' && first !== '' && first !== '[redacted]') path = first;
    // The issue's own words (the platform's contract, readable in the log) say a missing field.
    const said = p.issues?.[0]?.message;
    named = typeof said === 'string' && / is required\.$/.test(said);
  } catch {
    // No readable body (older than a day, or not JSON): the status and code still say what happened.
  }
  const leaf = path?.startsWith('input.')
    ? path.slice('input.'.length)
    : entry.status === 422 || entry.code === 'PASS_INPUT_INVALID'
      ? missingField(bodies.request, sample)
      : null;
  // A path naming the field is not enough for "required": a wrong type names it too, so only the field the body lacks gets that title.
  if (leaf && (!path || named || leaf === missingField(bodies.request, sample))) {
    path = `input.${leaf}`;
    title = QS_COPY.fail.required(leaf);
  }
  const value = leaf && sample ? sample[leaf] : undefined;
  const line =
    leaf && typeof value === 'string'
      ? QS_COPY.fail.addField(leaf, value)
      : path
        ? QS_COPY.fail.checkField(path)
        : '';
  return { title, line, repair: false, code: entry.code ?? undefined, path };
}

/** `201 CREATED` and `3:42`-style help for a call heard from a terminal. */
export const shortId = (id: string): string =>
  id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
