export const SETUP_APPLY = 'org_mode.scan.setup.apply';

/** The scan admin grants a `scanning:write` key may hold: a template's scan setup, a device or scanner with no code, and the one-call setup (which refuses zones and staff for it). */
export const WRITE_KEY_PURPOSES: ReadonlySet<string> = new Set([
  'org_mode.scan.event.create',
  'org_mode.scan.event.archive',
  'org_mode.scan.event.update',
  'org_mode.scan.session.create',
  'org_mode.scan.session.update',
  'org_mode.scan.session.hold',
  'org_mode.scan.device.update',
  'org_mode.scan.event.assign',
  'org_mode.scan.scanner.update',
  'org_mode.scan.scanner.revoke',
  'org_mode.scan.visits.reset',
  SETUP_APPLY,
  'org_mode.scan.setup.create',
  'org_mode.scan.scanner.create',
  'org.scan.zone.create',
  'org.scan.zone.update',
  'org.scan.scanner.mode',
]);

/** What a live, org-bound `scanning:admin` key may hold: the setup, pairing codes, till tokens and staff. Never pair-here, redeem, unpair, an admin session or a tag. */
export const ADMIN_KEY_PURPOSES: ReadonlySet<string> = new Set([
  SETUP_APPLY,
  'org_mode.scan.setup.create',
  'org_mode.scan.scanner.create',
  'org_mode.scan.pairing.create',
  'org_mode.scan.pairing.token',
  'org.scan.staff.create',
  'org.scan.staff.update',
  'org.scan.staff.pin_reset',
]);
