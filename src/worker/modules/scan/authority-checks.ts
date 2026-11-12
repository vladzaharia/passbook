import { type Check, exactlyOne, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { gt } from '../../platform/authority-expr.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { epochsMissing } from './authority-capture.ts';

export { captureScanEpochs } from './authority-capture.ts';

import type { ScanActor } from './actor.ts';
import {
  deviceAwakeCheck,
  noScannerTemplatesCheck,
  noStaffBindingCheck,
  scannerTemplateCheck,
  sessionAcceptsTemplateCheck,
} from './repo-scan-checks.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { scanEpochsOf } from './scan-epochs.ts';
import { STAFF_IDLE_MS, STAFF_MAX_MS } from './staff-binding.ts';

/** The principal a scan write or read is granted to. Throws `SCAN_EPOCHS_MISSING` when the guard did not capture epochs. */
export function scanPrincipal(actor: ScanActor): Principal {
  if (actor.principal === 'scanner') {
    const scanner = scanEpochsOf(actor)?.scanner;
    if (!scanner || scanner.id !== actor.actor.id) throw epochsMissing();
    return { kind: 'scanner', scannerId: scanner.id, credentialEpoch: scanner.credential };
  }
  const authority = actor.tenantAuthority;
  if (
    authority?.kind !== 'session' ||
    authority.orgId !== actor.orgId ||
    authority.userId !== actor.actor.id
  )
    throw epochsMissing();
  // `orgUpdatedAt` is the org's access revision: a suspend and reactivate since capture refuses.
  return {
    kind: 'membership',
    via: 'session',
    membershipId: authority.membershipId,
    sessionIdHash: authority.sessionId,
    orgAccessRevision: authority.orgUpdatedAt,
    mode: actor.mode,
  };
}

export interface ScanChecksInput {
  now: number;
  /** A second event the operation depends on (for example the pass's event). */
  event?: ScanEventRow | null;
  /** The scanned pass's template; only this template's membership is checked, not every scoped one. */
  templateId?: string;
}

/**
 * Staleness and binding checks for the actor, as grant checks. Liveness of the credential, expiry
 * and org status come from the principal; these cover what the actor derived its scope from.
 * Config drift is `config` (409 `SCAN_CONFIG_CHANGED`, no unpair). Staff drift uses `staff` (409
 * `SCAN_STAFF_CHANGED`, no unpair; `actor` would unpair the device). An actor the
 * guard never captured throws `SCAN_EPOCHS_MISSING` (500).
 */
export function scanActorChecks(actor: ScanActor, input: ScanChecksInput): Check[] {
  const epochs = scanEpochsOf(actor);
  if (!epochs) throw epochsMissing();
  const checks: Check[] = [];
  const { scanner, scanningSession: session } = actor;
  if (scanner) {
    if (epochs.scanner?.id !== scanner.id) throw epochsMissing();
    checks.push(
      rowIs(
        'scanners',
        scanner.id,
        { config_epoch: epochs.scanner.config, revoked_at: null },
        'config',
      ),
    );
    // The scanner principal carries its credential epoch itself; an admin acting through a managed
    // scanner is refused when that device is re-paired.
    if (actor.principal === 'admin')
      checks.push(
        rowIs('scanners', scanner.id, { credential_epoch: epochs.scanner.credential }, 'actor'),
      );
    if (actor.principal === 'scanner' && !actor.terminal) {
      checks.push(deviceAwakeCheck(scanner.id, input.now));
      if (actor.staff) {
        if (epochs.staff?.id !== actor.staff.id) throw epochsMissing();
        checks.push(
          rowIs(
            'scan_staff',
            actor.staff.id,
            { auth_epoch: epochs.staff.auth, disabled_at: null },
            'staff',
          ),
          exactlyOne(
            'scanners',
            {
              id: scanner.id,
              staff_id: actor.staff.id,
              staff_seen_at: gt(input.now - STAFF_IDLE_MS - 1),
              staff_since: gt(input.now - STAFF_MAX_MS - 1),
            },
            undefined,
            'staff',
          ),
        );
      }
      // No staff was derived: the device must still have no valid binding (none, expired or disabled).
      else checks.push(noStaffBindingCheck(scanner.id, input.now));
    }
  }
  if (session) {
    if (epochs.session?.id !== session.id) throw epochsMissing();
    if (session.status !== 'active') return [rawCheck('config', '0')];
    checks.push(
      rowIs(
        'scanning_sessions',
        session.id,
        { config_epoch: epochs.session.config, status: 'active' },
        'config',
      ),
    );
    if (scanner)
      checks.push(
        exactlyOne(
          'scanning_devices',
          { scanner_id: scanner.id, session_id: session.id },
          undefined,
          'config',
        ),
      );
  }
  if (actor.event) {
    const epoch = epochs.events[actor.event.id];
    if (epoch === undefined) throw epochsMissing();
    checks.push(
      rowIs('scan_events', actor.event.id, { config_epoch: epoch, archived_at: null }, 'config'),
    );
  }
  // The operation's own event is usually not the actor's: its epoch was not captured at the guard,
  // so compare its configuration columns instead.
  const other = input.event;
  if (other && other.id !== actor.event?.id) {
    const epoch = epochs.events[other.id];
    checks.push(
      rowIs(
        'scan_events',
        other.id,
        epoch !== undefined
          ? { config_epoch: epoch, archived_at: null }
          : {
              archived_at: null,
              match_input: other.matchInput,
              match_values: other.matchValues,
              opens_at: other.opensAt,
              closes_at: other.closesAt,
              time_zone: other.timeZone,
              capacity: other.capacity,
              reentry: other.reentry,
            },
        'config',
      ),
    );
  }
  const { templateId } = input;
  if (templateId) {
    if (actor.event)
      checks.push(
        exactlyOne(
          'scan_event_templates',
          { event_id: actor.event.id, template_id: templateId },
          'event_id',
          'config',
        ),
      );
    else if (session && actor.templateIds.length > 0)
      checks.push(sessionAcceptsTemplateCheck(session.id, templateId));
    else if (scanner && !session && actor.templateIds.length > 0)
      checks.push(scannerTemplateCheck(scanner.id, templateId));
  }
  // scanner_templates has no epoch: an unrestricted scanner must still have no template list.
  if (scanner && !session && !actor.event && actor.templateIds.length === 0)
    checks.push(noScannerTemplatesCheck(scanner.id));
  return checks;
}
