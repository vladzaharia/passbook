import type { Mode } from '../../../shared/contracts/common.ts';
import { TimeZoneSchema } from '../../../shared/contracts/scan.ts';
import type { SqlValue } from '../../platform/db.ts';
import {
  denySampleScannerScope as deny,
  sampleScannerScopePredicate,
} from './repo-sample-scope-fence.ts';
import type { ConsoleScannerRow } from './repo-scanners.ts';
import type { ScanningDeviceRow } from './repo-scanning-devices.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import type { ScanEventRow } from './repo-scope.ts';

type ScannerSnapshot = Readonly<
  Pick<
    ConsoleScannerRow,
    | 'id'
    | 'orgId'
    | 'mode'
    | 'kind'
    | 'deviceRole'
    | 'eventId'
    | 'settings'
    | 'timeZone'
    | 'updatedAt'
    | 'revokedAt'
  >
>;
type SessionSnapshot = Readonly<
  Pick<
    ScanningSessionRow,
    'id' | 'org_id' | 'mode' | 'status' | 'accepts' | 'settings' | 'time_zone' | 'updated_at'
  >
>;
type DeviceSnapshot = Readonly<
  Pick<
    ScanningDeviceRow,
    | 'scanner_id'
    | 'session_id'
    | 'org_id'
    | 'mode'
    | 'surface'
    | 'effective_surface'
    | 'overrides'
    | 'admin_user_id'
    | 'device_key'
  >
>;
type ScopeSnapshot = Readonly<{
  event: Readonly<ScanEventRow> | null;
  templateIds: readonly string[];
}>;

/** Exactly what sample issuance observed, not an independently reusable authority grant. */
export interface SampleScannerScope {
  readonly scanner: ScannerSnapshot;
  readonly scannerScope: ScopeSnapshot;
  readonly session: Readonly<{
    row: SessionSnapshot;
    device: DeviceSnapshot;
    scope: ScopeSnapshot & Readonly<{ restricted: boolean }>;
  }> | null;
}

type Predicate = { sql: string; params: SqlValue[] };
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const timestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function validIds(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every((id) => text(id) && id.length <= 64) &&
    new Set(value).size === value.length
  );
}

function validEvent(event: Readonly<ScanEventRow>, orgId: string, mode: Mode): boolean {
  if (
    !event ||
    !text(event.id) ||
    event.id.length > 64 ||
    event.orgId !== orgId ||
    event.mode !== mode ||
    !text(event.name) ||
    !nullableText(event.matchInput) ||
    !nullableText(event.matchValues) ||
    !timestamp(event.opensAt) ||
    !timestamp(event.closesAt) ||
    event.closesAt <= event.opensAt ||
    !TimeZoneSchema.safeParse(event.timeZone).success ||
    (event.capacity !== null && (!Number.isSafeInteger(event.capacity) || event.capacity <= 0)) ||
    typeof event.reentry !== 'boolean' ||
    !nullableText(event.note) ||
    !timestamp(event.updatedAt) ||
    event.archivedAt !== null
  )
    return false;
  if (event.matchInput === null && event.matchValues === null) return true;
  if (
    !event.matchInput ||
    event.matchInput.length > 64 ||
    /["\\]/.test(event.matchInput) ||
    event.matchValues === null
  )
    return false;
  try {
    const values: unknown = JSON.parse(event.matchValues);
    return (
      Array.isArray(values) &&
      values.length > 0 &&
      values.length <= 20 &&
      values.every((value) => text(value) && value.length <= 120)
    );
  } catch {
    return false;
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((id) => expected.has(id));
}

/** Rechecks the scanner, its exact scope, and any session binding in the pass INSERT. */
export function sampleScannerScopeFence(
  snapshot: SampleScannerScope,
  orgId: string,
  mode: Mode,
  templateId: string,
): Predicate {
  const scanner = snapshot?.scanner;
  const scannerScope = snapshot?.scannerScope;
  if (
    !scanner ||
    !scannerScope ||
    !text(orgId) ||
    mode !== 'test' ||
    !text(templateId) ||
    !text(scanner.id) ||
    scanner.orgId !== orgId ||
    scanner.mode !== mode ||
    !['device', 'terminal', 'display'].includes(scanner.kind) ||
    !['scan', 'customer', 'monitor'].includes(scanner.deviceRole) ||
    !nullableText(scanner.eventId) ||
    typeof scanner.settings !== 'string' ||
    !text(scanner.timeZone) ||
    !timestamp(scanner.updatedAt) ||
    (scanner.revokedAt !== null && !timestamp(scanner.revokedAt)) ||
    !validIds(scannerScope.templateIds) ||
    (scanner.eventId === null
      ? scannerScope.event !== null
      : !scannerScope.event ||
        scannerScope.event.id !== scanner.eventId ||
        !validEvent(scannerScope.event, orgId, mode) ||
        scannerScope.templateIds.length === 0)
  )
    return deny();

  const predicate = sampleScannerScopePredicate(scanner, scannerScope, orgId, mode);

  const session = snapshot.session;
  let effective = scannerScope.templateIds;
  if (session === null) {
    predicate.withoutSession();
  } else {
    const row = session?.row;
    const device = session?.device;
    const scope = session?.scope;
    if (
      !row ||
      !device ||
      !scope ||
      !text(row.id) ||
      row.org_id !== orgId ||
      row.mode !== mode ||
      !['active', 'paused', 'ended'].includes(row.status) ||
      !nullableText(row.accepts) ||
      typeof row.settings !== 'string' ||
      !text(row.time_zone) ||
      !timestamp(row.updated_at) ||
      device.scanner_id !== scanner.id ||
      device.session_id !== row.id ||
      device.org_id !== orgId ||
      device.mode !== mode ||
      !text(device.surface) ||
      !text(device.effective_surface) ||
      typeof device.overrides !== 'string' ||
      !nullableText(device.admin_user_id) ||
      !nullableText(device.device_key) ||
      !validIds(scope.templateIds) ||
      typeof scope.restricted !== 'boolean'
    )
      return deny();

    if (row.accepts === null) {
      if (scope.restricted || scope.event !== null || scope.templateIds.length !== 0) return deny();
    } else {
      let accepts: unknown;
      try {
        accepts = JSON.parse(row.accepts);
      } catch {
        return deny();
      }
      if (
        !accepts ||
        typeof accepts !== 'object' ||
        Array.isArray(accepts) ||
        Object.keys(accepts).length !== 1 ||
        !scope.restricted
      )
        return deny();
      const value = accepts as { eventId?: unknown; templateIds?: unknown };
      if (typeof value.eventId === 'string') {
        if (
          !scope.event ||
          scope.event.id !== value.eventId ||
          !validEvent(scope.event, orgId, mode) ||
          scope.templateIds.length === 0
        )
          return deny();
      } else if (validIds(value.templateIds)) {
        if (scope.event !== null || !sameIds(value.templateIds, scope.templateIds)) return deny();
      } else return deny();
    }
    predicate.withSession(row, device, scope);
    effective = scope.templateIds;
  }
  if (!effective.includes(templateId)) return deny();

  return predicate.finish();
}
