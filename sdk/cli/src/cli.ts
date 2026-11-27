import { parseArgs } from 'node:util';
import type { Api } from './api.ts';
import { type AuthIo, authCommand, originFor } from './auth-commands.ts';
import { DEFAULT_ORIGIN } from './credentials.ts';
import { receiverUrl } from './forward.ts';
import { listen } from './listen.ts';
import { followLogs } from './logs.ts';
import { passesCommand } from './passes.ts';
import { triggerCommand } from './trigger.ts';
import { inputTypeFile, typeName } from './types-gen.ts';

/** Keep equal to `version` in package.json (a test checks). */
export const CLI_VERSION = '0.2.0';

export const HELP = `passbook <command>

  login                       Sign in with your browser: a Test token for your sandbox or an org, kept 30 days.
      [--switch] [--no-browser]
  logout                      End this sign-in and forget it.
  open [id|tool]              Open the Workbench, a tool (logs, events, passes...) or a pasted id.

  listen --forward-to <url>   Forward webhook captures to a local server, with their original signatures.
      [--endpoint <id>] [--interval <ms>] [--from-start] [--once]
  logs --follow               Print your Test calls as they arrive, oldest first.
      [--status 4xx] [--code <CODE>] [--interval <ms>] [--once]
  types <templateId>          Print the TypeScript type of a template's pass input.
      [--name <TypeName>] [--out <file>]
  passes create               Issue a pass. Body from --file <json|-> (- is stdin) and flags.
      [--template <id>] [--email <e>] [--external-id <id>] [--serial <s>] [--send-email]
      [--set key=value]... [--idempotency-key <k>]
  passes update <passId>      Change a pass's input. Same body sources.
      [--external-id <id>] [--template-version <v>] [--notify] [--set key=value]... [--idempotency-key <k>]
  trigger <event>             Send a real Test event for a pass: installed, uninstalled, scanned,
      [--pass <id>] [--device <id>]   scan_refused, push_failed, updated_on_device or email_failed.
                                      Without --pass, the newest Test pass.

PASSBOOK_KEY holds a pbp_test_ key (logs needs the logs:read scope) and wins over a sign-in. PASSBOOK_BASE_URL overrides
https://passbook.mobile; a sign-in is sent only to the origin that issued it.`;

export interface Io extends AuthIo {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  writeFile: (path: string, text: string) => Promise<void>;
  /** Builds the API client for a key; bin.ts passes `new PassBook(...)`. */
  makeClient: (options: { apiKey: string; baseUrl?: string; userAgent?: string }) => Api;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
}

/** Runs a command line and returns the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.out(HELP);
    return command ? 0 : 1;
  }
  let signedIn = false;
  try {
    if (command === 'login' || command === 'logout' || command === 'open') {
      await authCommand(command, rest, io, CLI_VERSION);
      return 0;
    }
    const creds = await credentialsFor(io);
    signedIn = creds.signedIn;
    const api = io.makeClient({
      apiKey: creds.apiKey,
      userAgent: `passbook-cli/${CLI_VERSION}`,
      ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
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
    if (command === 'logs') {
      const { values } = parseArgs({
        args: rest,
        options: {
          follow: { type: 'boolean' },
          status: { type: 'string' },
          code: { type: 'string' },
          interval: { type: 'string' },
          once: { type: 'boolean' },
        },
      });
      if (!values.follow) throw new Error('logs needs --follow.');
      if (values.status && !/^(?:[1-5]xx|[1-5]\d\d)$/.test(values.status))
        throw new Error('--status is a class such as 4xx, or one status such as 404.');
      const interval = Number(values.interval ?? 2000);
      if (!Number.isFinite(interval) || interval < 200)
        throw new Error('--interval is milliseconds, at least 200.');
      await followLogs({
        api,
        ...(values.status ? { status: values.status } : {}),
        ...(values.code ? { code: values.code } : {}),
        intervalMs: interval,
        once: values.once === true,
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
    if (command === 'trigger') {
      await triggerCommand(api, rest, io.out);
      return 0;
    }
    throw new Error(`Unknown command "${command}". Run passbook --help.`);
  } catch (e) {
    const { code, detail } = e as { code?: unknown; detail?: unknown };
    if (signedIn && code === 'INVALID_API_KEY') io.err('Your sign-in ended. Run passbook login.');
    else if (typeof code === 'string' && typeof detail === 'string') io.err(`${code}: ${detail}`);
    else io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

/**
 * The key a command sends: `PASSBOOK_KEY` wins. Else the stored sign-in of the origin in use, and only that origin's:
 * a base URL set to another host never receives it.
 */
async function credentialsFor(
  io: Io,
): Promise<{ apiKey: string; baseUrl?: string; signedIn: boolean }> {
  const key = io.env.PASSBOOK_KEY?.trim();
  if (key)
    return {
      apiKey: key,
      signedIn: false,
      ...(io.env.PASSBOOK_BASE_URL ? { baseUrl: io.env.PASSBOOK_BASE_URL } : {}),
    };
  const origin = originFor(io.env);
  const profile = await io.credentials?.get(origin);
  if (profile && profile.expiresAt > (io.now ?? Date.now)())
    return { apiKey: profile.token, baseUrl: origin, signedIn: true };
  if (profile) throw new Error('Your sign-in expired. Run passbook login.');
  const elsewhere = origin !== DEFAULT_ORIGIN && (await io.credentials?.get(DEFAULT_ORIGIN));
  throw new Error(
    elsewhere
      ? `Set PASSBOOK_KEY, or run passbook login for ${origin}. The sign-in for ${DEFAULT_ORIGIN} is not sent there.`
      : 'Set PASSBOOK_KEY to a pbp_test_ key, or run passbook login.',
  );
}
