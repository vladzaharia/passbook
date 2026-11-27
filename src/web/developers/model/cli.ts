import { SDK_STATUS, type SdkStatus } from '../../../shared/developers-sdk.ts';
import { shQuote } from './code-literals.ts';
import { pathValue } from './ids.ts';
import type { SampleOp } from './sample-ts.ts';
import type { Sample } from './samples.ts';
import type { OpView } from './types.ts';

/** `--set key=value` for each scalar field of the sample's `input`: the CLI lays them over the body. */
function sets(op: Pick<OpView, 'sample'>): string[] {
  const body = op.sample.body;
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body.input : undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  return Object.entries(input)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .slice(0, 3)
    .map(([k, v]) => `  --set ${shQuote(`${k}=${v}`)}`);
}

/** The command that makes the same call, for the operations the CLI has a command for. */
function command(
  op: Pick<OpView, 'sdkCall' | 'path' | 'sample'> & Pick<SampleOp, 'ids'>,
): string | null {
  const id = op.ids?.id || pathValue(op.path, 'id', 'string');
  switch (op.sdkCall) {
    case 'pb.passes.create':
      return ['passbook passes create --template $PASSBOOK_TEMPLATE_ID', ...sets(op)].join(' \\\n');
    case 'pb.passes.update':
      return [`passbook passes update ${id}`, ...sets(op), '  --notify'].join(' \\\n');
    case 'pb.templates.retrieveInputSchema':
      return `passbook types ${id} > passbook-types.ts`;
    case 'pb.webhookEndpoints.captures.list':
      return 'passbook listen --forward-to localhost:3000/hooks';
    default:
      return null;
  }
}

/** A CLI tab, only where there is a command. It reads the key from `PASSBOOK_KEY`. */
export function cliSample(
  op: Pick<OpView, 'sdkCall' | 'path' | 'sample'> & Pick<SampleOp, 'ids'>,
  status: SdkStatus = SDK_STATUS,
): Sample[] {
  const cmd = command(op);
  if (!cmd) return [];
  const code = status.cli ? cmd.replace(/^passbook /, 'npx @passbook/cli ') : cmd;
  return [
    {
      lang: 'cli',
      label: 'CLI',
      file: 'terminal',
      code,
      soon: !status.cli,
    },
  ];
}
