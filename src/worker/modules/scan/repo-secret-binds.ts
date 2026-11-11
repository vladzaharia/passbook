import type { SqlValue } from '../../platform/db.ts';

/** Only explicitly labeled SQL placeholders may carry sensitive values through a packed fence. */
export const SCAN_SECRET_BIND_LABELS = [
  'csrf',
  'scanner-csrf',
  'session-csrf',
  'source-scanner-csrf',
  'source-session-csrf',
  'recipient-scanner-csrf',
  'recipient-session-csrf',
  'csrf:actor:session',
  'csrf:actor:scanner',
  'csrf:source:session',
  'csrf:source:scanner',
  'csrf:recipient:session',
  'csrf:recipient:scanner',
  'asset-recipient-session-csrf',
  'asset-recipient-scanner-csrf',
  'asset-source-session-csrf',
  'asset-source-scanner-csrf',
  'serial',
  'personalization',
  'holder-email',
  'owner-id',
  'download-token',
  'auth-token',
  'object-key',
  'scan-code',
  'barcode-hash',
  'lookup-hash',
  'wallet-json',
  'wallet-personalization',
  'web-service-url',
  'external-id',
  'display-title',
  'display-subtitle',
  'check-in-rules',
  'photo-key',
  'sync-error-code',
  'version-personalization',
  'history-snapshot',
  'proof',
  'credential-refs',
  'pass-json',
  'field-sources',
  'external-ref',
  'action-id',
  'source-event-json',
  'actor-key',
  'actor-id',
  'scanner-id',
  'staff-id',
  'approver-id',
  'idempotency-key',
  'request-hash',
  'pass-id',
  'pass-id-list',
  'template-id',
  'event-id',
  'scan-id',
  'event-scope',
  'template-ids',
  'scan-actor',
  'event-actor',
  'event-json',
  'scanner-token-hash',
  'scanner-token-prefix',
  'session-id',
  'session-user-id',
  'session-id-hash',
  'staff-pin-hash',
  'scan-id-list',
  'scope-template-rows',
  'scope-event-templates',
  'scope-scanner-templates',
  'gate-snapshot',
  'presence-snapshot',
  'undo-target-snapshot',
  'undo-gate-snapshot',
  'event-name',
  'event-note',
  'event-time-zone',
  'session-name',
  'session-settings',
  'session-accepts',
  'session-time-zone',
  'scanner-time-zone',
  'device-overrides',
  'device-capabilities',
  'device-key',
  'scope-event-rows',
  'history-pass-id',
  'history-template-id',
  'history-scanner-id',
  'history-event-id',
  'history-id',
  'history-at',
  'history-ledger-id',
  'history-ledger-at',
  'history-actor-key',
  'history-staff-id',
  'history-reason',
  'history-action-id',
  'history-override-of',
  'history-approved-by',
  'history-undone-by',
  'history-presence-scope',
  'history-amount',
  'history-before-value',
  'history-after-value',
  'history-ledger-pass-id',
  'history-ledger-device',
  'history-ledger-actor-id',
  'history-ledger-data',
  'history-recorded-personalization',
  'history-recorded-wallet-template-version',
  'history-recorded-template-version',
  'history-event-pinned-manifest',
  'history-event-wallet-manifest',
  'history-event-active-version',
  'history-event-active-manifest',
  'history-current-personalization',
  'history-current-scanner-name',
  'history-pass-private-values',
  'history-current-wallet-private-values',
  'history-current-pinned-version',
  'history-current-pinned-manifest',
  'history-current-active-version',
  'history-current-active-manifest',
  'history-current-identity-id',
  'history-current-connection-id',
  'undo-event-json',
  'undo-action-id',
  'scanner-settings',
  'effective-settings',
  'undo-idempotency-key',
  'event-match-input',
  'event-match-values',
  'event-device',
  'scanner-name',
  'staff-name',
  'template-snapshot',
  'card-history',
  'asset-personalization',
  'asset-field-sources',
  'asset-external-ref',
  'asset-photo-key',
  'asset-auth-token',
  'asset-scan-code',
  'asset-token-hash',
  'asset-credential-refs',
  'asset-session-id',
  'asset-session-user-id',
  'asset-session-membership-id',
  'asset-session-id-hash',
] as const;
export type ScanSecretBindLabel = (typeof SCAN_SECRET_BIND_LABELS)[number];
const allowedLabels = new Set<string>(SCAN_SECRET_BIND_LABELS);

export interface ScanSecretSlot {
  /** Offset of the original positional placeholder in the SQL. */
  offset: number;
  label: ScanSecretBindLabel | null;
}

/**
 * Parse positional binds without treating quoted text or comments as placeholders.
 * An ephemeral marker is valid only immediately after its placeholder. Repeated labels
 * are permitted: the occurrence order is the builder's positional binding contract.
 */
export function scanSecretSlots(sql: string, paramCount: number): ScanSecretSlot[] | null {
  const slots: ScanSecretSlot[] = [];
  let at = 0;
  while (at < sql.length) {
    const ch = sql[at];
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      at++;
      let closed = false;
      while (at < sql.length) {
        if (sql[at] !== close) {
          at++;
          continue;
        }
        if (sql[at + 1] === close) {
          at += 2;
          continue;
        }
        at++;
        closed = true;
        break;
      }
      if (!closed) return null;
      continue;
    }
    if (ch === '-' && sql[at + 1] === '-') {
      const end = sql.indexOf('\n', at + 2);
      at = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (ch === '/' && sql[at + 1] === '*') {
      const end = sql.indexOf('*/', at + 2);
      if (
        end < 0 ||
        sql
          .slice(at + 2, end)
          .trim()
          .startsWith('scan-ephemeral')
      )
        return null;
      at = end + 2;
      continue;
    }
    // SQLite named parameters cannot be remapped by positional occurrence.
    if ((ch === ':' || ch === '@' || ch === '$') && /[A-Za-z0-9_]/.test(sql[at + 1] ?? ''))
      return null;
    if (ch !== '?') {
      at++;
      continue;
    }
    const offset = at++;
    // Numbered placeholders cannot be remapped by positional occurrence.
    if (/[0-9]/.test(sql[at] ?? '')) return null;
    let label: ScanSecretBindLabel | null = null;
    if (sql.startsWith('/*', at)) {
      const end = sql.indexOf('*/', at + 2);
      if (end < 0) return null;
      const content = sql.slice(at + 2, end);
      if (content.trim().startsWith('scan-ephemeral')) {
        const match = /^ scan-ephemeral-([a-z0-9]+(?:[-:][a-z0-9]+)*) $/.exec(content);
        if (!match?.[1] || !allowedLabels.has(match[1])) return null;
        label = match[1] as ScanSecretBindLabel;
        at = end + 2;
      }
    }
    slots.push({ offset, label });
  }
  return slots.length === paramCount ? slots : null;
}

/** Preserve predicate order while bounding long, generated AND trees for D1. */
export function scanConjunction(parts: readonly string[]): string {
  if (!parts.length) return '1';
  const groups: string[] = [];
  for (let index = 0; index < parts.length; index += 4)
    groups.push(
      `(${parts
        .slice(index, index + 4)
        .map((part) => `(${part})`)
        .join(' AND ')})`,
    );
  return groups.join(' AND ');
}

/** Pack nonsecret metadata while keeping labeled values as ordered standalone D1 binds. */
export function packScanPredicate(
  sql: string,
  params: readonly SqlValue[],
  alias: string,
): { sql: string; params: SqlValue[] } | null {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) return null;
  const slots = scanSecretSlots(sql, params.length);
  if (!slots) return null;
  const metadata: SqlValue[] = [];
  const secrets: SqlValue[] = [];
  let expression = '';
  let previous = 0;
  for (const [index, slot] of slots.entries()) {
    const value = params[index];
    const binary = value instanceof ArrayBuffer || value instanceof Uint8Array;
    if (
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (value != null &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean' &&
        !binary)
    )
      return null;
    expression += sql.slice(previous, slot.offset);
    if (slot.label) {
      expression += '?';
      secrets.push(value);
    } else {
      if (binary) return null;
      expression += `json_extract(${alias}.data,'$[${metadata.length}]')`;
      metadata.push(value);
    }
    previous = slot.offset + 1;
  }
  expression += sql.slice(previous);
  // One metadata bind precedes the scalar binds; remain below D1's 100-bind limit.
  if (secrets.length > 98) return null;
  return {
    sql: `EXISTS (SELECT 1 FROM (SELECT json(?) AS data) ${alias} WHERE ${expression})`,
    params: [JSON.stringify(metadata), ...secrets],
  };
}
