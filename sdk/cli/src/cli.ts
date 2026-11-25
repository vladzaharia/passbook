import { parseArgs } from 'node:util';
import type { Api } from './api.ts';
import { receiverUrl } from './forward.ts';
import { listen } from './listen.ts';
import { passesCommand } from './passes.ts';
import { inputTypeFile, typeName } from './types-gen.ts';

/** Keep equal to `version` in package.json (a test checks). */
export const CLI_VERSION = '0.1.0';

export const HELP = `passbook <command>

  listen --forward-to <url>   Forward webhook captures to a local server, with their original signatures.
      [--endpoint <id>] [--interval <ms>] [--from-start] [--once]
  types <templateId>          Print the TypeScript type of a template's pass input.
      [--name <TypeName>] [--out <file>]
  passes create               Issue a pass. Body from --file <json|-> (- is stdin) and flags.
      [--template <id>] [--email <e>] [--external-id <id>] [--serial <s>] [--send-email]
      [--set key=value]... [--idempotency-key <k>]
  passes update <passId>      Change a pass's input. Same body sources.
      [--external-id <id>] [--template-version <v>] [--notify] [--set key=value]... [--idempotency-key <k>]

PASSBOOK_KEY holds a pbp_test_ key. PASSBOOK_BASE_URL overrides https://passbook.mobile.`;

export interface Io {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  writeFile: (path: string, text: string) => Promise<void>;
  /** Builds the API client for a key; bin.ts passes `new PassBook(...)`. */
  makeClient: (options: { apiKey: string; baseUrl?: string; userAgent?: string }) => Api;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Runs a command line and returns the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.out(HELP);
    return command ? 0 : 1;
  }
  try {
    const apiKey = io.env.PASSBOOK_KEY?.trim();
    if (!apiKey) throw new Error('Set PASSBOOK_KEY to a pbp_test_ key.');
    const api = io.makeClient({
      apiKey,
      userAgent: `passbook-cli/${CLI_VERSION}`,
      ...(io.env.PASSBOOK_BASE_URL ? { baseUrl: io.env.PASSBOOK_BASE_URL } : {}),
    });
    if (command === 'listen') {
      const { values } = parseArgs({
        args: rest,
        options: {
          'forward-to': { type: 'string' },
          endpoint: { type: 'string' },
          interval: { type: 'string' },
          'from-start': { type: 'boolean' },
          once: { type: 'boolean' },
        },
      });
      if (!values['forward-to'])
        throw new Error('listen needs --forward-to <url>, such as localhost:3000/hooks.');
      const interval = Number(values.interval ?? 2000);
      if (!Number.isFinite(interval) || interval < 200)
        throw new Error('--interval is milliseconds, at least 200.');
      receiverUrl(values['forward-to']);
      await listen({
        api,
        forwardTo: values['forward-to'],
        ...(values.endpoint ? { endpointId: values.endpoint } : {}),
        intervalMs: interval,
        fromStart: values['from-start'] === true,
        once: values.once === true,
        ...(io.fetch ? { fetch: io.fetch } : {}),
        ...(io.signal ? { signal: io.signal } : {}),
        log: io.out,
      });
      return 0;
    }
    if (command === 'types') {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { name: { type: 'string' }, out: { type: 'string' } },
        allowPositionals: true,
      });
      const [templateId] = positionals;
      if (!templateId) throw new Error('types needs a template id: passbook types <templateId>.');
      const [schema, template] = await Promise.all([
        api.templates.retrieveInputSchema(templateId),
        api.templates.retrieve(templateId),
      ]);
      const text = inputTypeFile(schema, values.name ?? `${typeName(template.name)}Input`, {
        templateId,
        template: template.name,
      });
      if (values.out) await io.writeFile(values.out, text);
      else io.out(text.trimEnd());
      return 0;
    }
    if (command === 'passes') {
      await passesCommand(
        api,
        rest,
        {
          readFile: io.readFile ?? (async () => Promise.reject(new Error('Cannot read files.'))),
          readStdin: io.readStdin ?? (async () => Promise.reject(new Error('Cannot read stdin.'))),
        },
        io.out,
      );
      return 0;
    }
    throw new Error(`Unknown command "${command}". Run passbook --help.`);
  } catch (e) {
    const { code, detail } = e as { code?: unknown; detail?: unknown };
    if (typeof code === 'string' && typeof detail === 'string') io.err(`${code}: ${detail}`);
    else io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
