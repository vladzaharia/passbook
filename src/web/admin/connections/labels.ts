import type { Lifecycle } from './lifecycle-fields.tsx';

/** One sentence per connector error code (see ConnectorErrorCode in the worker). */
const ERROR_MESSAGE: Record<string, string> = {
  AUTH: 'The source rejected the credentials. Replace them.',
  FORBIDDEN: 'The credentials lack access to this data.',
  RATE_LIMITED: 'The source is rate limiting requests. Retries are automatic.',
  UPSTREAM: 'The source returned an error. Retries are automatic.',
  TIMEOUT: 'The source did not respond in time.',
  INVALID_PAYLOAD: 'The source returned data that does not match the mapping.',
  CONFIG: 'The connection configuration is invalid. Check Configuration.',
};

export function errorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return ERROR_MESSAGE[code] ?? 'The source reported an unknown error.';
}

export const MODE_LABEL: Record<Lifecycle['mode'], string> = {
  poll: 'Poll',
  webhook: 'Webhook',
  hybrid: 'Hybrid',
  manual: 'Manual',
  snapshot: 'Snapshot',
};

export function modeLabel(mode: string): string {
  return (MODE_LABEL as Record<string, string>)[mode] ?? mode;
}

export const HEALTH_FILTERS = [
  ['healthy', 'Healthy'],
  ['degraded', 'Degraded'],
  ['failing', 'Failing'],
  ['paused', 'Paused'],
  ['disabled', 'Disabled'],
  ['unknown', 'Unknown'],
] as const;
