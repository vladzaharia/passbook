import { parseArgs } from 'node:util';
import type { Api } from './api.ts';

export interface PassesIo {
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
}

const common = {
  file: { type: 'string' },
  set: { type: 'string', multiple: true },
  'external-id': { type: 'string' },
  'idempotency-key': { type: 'string' },
} as const;

/** The body: a JSON file (`--file -` reads stdin) with flags laid over it. */
async function baseBody(file: string | undefined, io: PassesIo): Promise<Record<string, unknown>> {
  if (!file) return {};
  const text = await (file === '-' ? io.readStdin() : io.readFile(file));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${file === '-' ? 'stdin' : file} is not valid JSON.`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('The body must be a JSON object.');
  return body as Record<string, unknown>;
}

function withInput(body: Record<string, unknown>, sets: string[] | undefined) {
  if (!sets?.length) return body;
  const input = { ...((body.input as Record<string, unknown> | undefined) ?? {}) };
  for (const pair of sets) {
    const at = pair.indexOf('=');
    if (at < 1) throw new Error(`--set takes key=value, got "${pair}".`);
    input[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return { ...body, input };
}

/** `passes create` and `passes update`; prints the pass as JSON. */
export async function passesCommand(
  api: Api,
  args: string[],
  io: PassesIo,
  out: (line: string) => void,
): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === 'create') {
    const { values } = parseArgs({
      args: rest,
      options: {
        ...common,
        template: { type: 'string' },
        email: { type: 'string' },
        serial: { type: 'string' },
        'send-email': { type: 'boolean' },
      },
    });
    const body = withInput(await baseBody(values.file, io), values.set);
    if (values.template) body.templateId = values.template;
    if (values.email) body.holderEmail = values.email;
    if (values['external-id']) body.externalId = values['external-id'];
    if (values.serial) body.serial = values.serial;
    if (values['send-email']) body.sendEmail = true;
    if (!body.templateId) throw new Error('passes create needs --template <templateId>.');
    const key = values['idempotency-key'];
    out(JSON.stringify(await api.passes.create(body, key ? { idempotencyKey: key } : {}), null, 2));
    return;
  }
  if (verb === 'update') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        ...common,
        'template-version': { type: 'string' },
        notify: { type: 'boolean' },
      },
      allowPositionals: true,
    });
    const [id] = positionals;
    if (!id) throw new Error('passes update needs a pass id: passbook passes update <passId>.');
    const body = withInput(await baseBody(values.file, io), values.set);
    if (values['external-id']) body.externalId = values['external-id'];
    if (values['template-version']) body.templateVersion = values['template-version'];
    if (values.notify) body.notify = true;
    if (!Object.keys(body).length)
      throw new Error('passes update needs a change: --file, --set key=value or a field flag.');
    const key = values['idempotency-key'];
    out(
      JSON.stringify(
        await api.passes.update(id, body, key ? { idempotencyKey: key } : {}),
        null,
        2,
      ),
    );
    return;
  }
  throw new Error('Use passbook passes create or passbook passes update <passId>.');
}
