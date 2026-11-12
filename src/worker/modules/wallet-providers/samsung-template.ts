import {
  assertSamsungCredentialsCurrent,
  type ValidatedSamsungCredentials,
} from './samsung-credentials.ts';
import { createSamsungAuthorizationToken } from './samsung-token.ts';

const ORIGIN = 'https://tsapi-card.walletsvc.samsung.com';
const PATH = '/partner/v1/card/template';
const MAX_RESPONSE_BYTES = 64 * 1024;

interface SamsungTemplateProbeInput {
  cardType: string;
  subType: string;
  countryCode: string;
  mode: 'live' | 'test';
  now?: number;
}

/** Current provider-reported template state, not independent approval of the issuer program. */
interface SamsungTemplateEvidence {
  cardId: string;
  cardType: string;
  subType: string;
  countryCode: string;
  state: 'ACTIVE';
  testingModeOff: 'Y';
  verifiedAt: number;
}

type SamsungTemplateErrorCode =
  | 'invalid_input'
  | 'network'
  | 'http'
  | 'invalid_response'
  | 'not_eligible';

/** Deliberately excludes authorization, request URL, and provider response body. */
export class SamsungTemplateError extends Error {
  readonly code: SamsungTemplateErrorCode;
  readonly status: number | undefined;

  constructor(code: SamsungTemplateErrorCode, status?: number) {
    super('Samsung Wallet template verification failed.');
    this.name = 'SamsungTemplateError';
    this.code = code;
    this.status = status;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** JSON.parse validates syntax; this scan detects repeated keys, including escaped equivalents. */
function rejectDuplicateKeys(text: string): void {
  const containers: (Set<string> | null)[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '{') {
      containers.push(new Set<string>());
      i++;
    } else if (char === '[') {
      containers.push(null);
      i++;
    } else if (char === '}' || char === ']') {
      containers.pop();
      i++;
    } else if (char === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\') i += 2;
        else if (text[i++] === '"') break;
      }
      let next = i;
      while (
        text[next] === ' ' ||
        text[next] === '\n' ||
        text[next] === '\r' ||
        text[next] === '\t'
      )
        next++;
      if (text[next] === ':') {
        const keys = containers.at(-1);
        const key: unknown = JSON.parse(text.slice(start, i));
        if (!keys || typeof key !== 'string' || keys.has(key))
          throw new SamsungTemplateError('invalid_response');
        keys.add(key);
      }
    } else {
      i++;
    }
  }
}

async function readTemplateResponse(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new SamsungTemplateError('invalid_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_RESPONSE_BYTES - size) {
        void reader.cancel().catch(() => undefined);
        throw new SamsungTemplateError('invalid_response');
      }
      chunks.push(value);
      size += value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    rejectDuplicateKeys(text);
    const page = object(parsed);
    if (!page) throw new SamsungTemplateError('invalid_response');
    return page;
  } catch {
    throw new SamsungTemplateError('invalid_response');
  }
}

/** https://developer.samsung.com/wallet/businesssupportforspecialpurposes/cardtemplatemanagement.html#Get-Wallet-Card-Template */
export async function probeSamsungActiveTemplate(
  account: ValidatedSamsungCredentials,
  input: SamsungTemplateProbeInput,
  fetcher: typeof fetch = fetch,
): Promise<SamsungTemplateEvidence> {
  if (
    !input ||
    typeof input.cardType !== 'string' ||
    !/^[a-z]{1,16}$/.test(input.cardType) ||
    typeof input.subType !== 'string' ||
    !/^[a-z]{1,16}$/.test(input.subType) ||
    typeof input.countryCode !== 'string' ||
    !/^[A-Z]{2}$/.test(input.countryCode) ||
    (input.mode !== 'live' && input.mode !== 'test')
  )
    throw new SamsungTemplateError('invalid_input');
  const now = input.now ?? Date.now();
  assertSamsungCredentialsCurrent(account, now);
  const path = `${PATH}/${account.cardId}`;
  const authorization = await createSamsungAuthorizationToken(account, {
    method: 'GET',
    path,
    now,
  });
  let response: Response;
  try {
    response = await fetcher(`${ORIGIN}${path}`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${authorization}`,
        'x-smcs-partner-id': account.partnerId,
        'x-request-id': crypto.randomUUID().replaceAll('-', ''),
      },
    });
  } catch {
    throw new SamsungTemplateError('network');
  }
  if (response.status !== 200) throw new SamsungTemplateError('http', response.status);
  const page = await readTemplateResponse(response);
  // Samsung's response table says `templates` while its example says `template`.
  const hasTemplate = Object.hasOwn(page, 'template');
  const hasTemplates = Object.hasOwn(page, 'templates');
  if (page.resultCode !== '0' || hasTemplate === hasTemplates)
    throw new SamsungTemplateError('invalid_response');
  const template = object(hasTemplate ? page.template : page.templates);
  if (!template) throw new SamsungTemplateError('invalid_response');
  if (
    template.cardId !== account.cardId ||
    template.cardType !== input.cardType ||
    template.subType !== input.subType ||
    template.countryCode !== input.countryCode ||
    template.state !== 'ACTIVE' ||
    template.testingModeOff !== 'Y'
  )
    throw new SamsungTemplateError('not_eligible');
  return {
    cardId: account.cardId,
    cardType: input.cardType,
    subType: input.subType,
    countryCode: input.countryCode,
    state: 'ACTIVE',
    testingModeOff: 'Y',
    verifiedAt: input.now ?? Date.now(),
  };
}
