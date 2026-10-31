import { parseJsonc, setJsonc } from './jsonc.ts';

export interface IdentityAddOptions {
  name: string;
  cert: string;
  key: string;
  binding: string;
  apply: boolean;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const BINDING = /^[A-Z][A-Z0-9_]{0,63}$/;

/** `--name platform` reads .secrets/platform-{certificate,key}.pem (written by npm run credentials). */
export function parseIdentityAddArgs(argv: string[]): IdentityAddOptions {
  const flags = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--apply') apply = true;
    else if (arg.startsWith('--')) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      flags.set(arg.slice(2), value);
    } else throw new Error(`Unexpected argument ${arg}.`);
  }
  const name = flags.get('name') ?? 'platform';
  if (!NAME.test(name)) throw new Error('Names use lowercase letters, digits and hyphens.');
  const binding =
    flags.get('binding') ??
    (name === 'platform' ? 'APNS' : `APNS_${name.toUpperCase().replaceAll('-', '_')}`);
  if (!BINDING.test(binding)) throw new Error('Binding names look like APNS_ACME.');
  return {
    name,
    cert: flags.get('cert') ?? `.secrets/${name}-certificate.pem`,
    key: flags.get('key') ?? `.secrets/${name}-key.pem`,
    binding,
    apply,
  };
}

export function uploadArgs(o: IdentityAddOptions): string[] {
  return [
    'wrangler',
    'mtls-certificate',
    'upload',
    '--cert',
    o.cert,
    '--key',
    o.key,
    '--name',
    `wallet-${o.name}`,
  ];
}

/** wrangler prints the new certificate's UUID; take the last one in the output. */
export function parseCertificateId(output: string): string {
  const ids = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  const id = ids?.at(-1);
  if (!id) throw new Error('No certificate id in the wrangler output.');
  return id.toLowerCase();
}

interface MtlsEntry {
  binding: string;
  certificate_id: string;
}

/** Adds or repoints an mtls_certificates binding, keeping comments in wrangler.jsonc. */
export function addMtlsBinding(text: string, binding: string, certificateId: string): string {
  const config = parseJsonc<{ mtls_certificates?: MtlsEntry[] }>(text, 'wrangler.jsonc');
  const entries = config.mtls_certificates ?? [];
  const at = entries.findIndex((e) => e.binding === binding);
  const entry: MtlsEntry = { binding, certificate_id: certificateId };
  return setJsonc(text, ['mtls_certificates', at === -1 ? entries.length : at], entry);
}
