import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import { ScanDeviceCapabilitiesSchema } from '../../../shared/contracts/scanning-sessions.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { all, first } from '../../platform/db.ts';
import { rolesGranting } from '../orgs/access.ts';

type Db = D1Database;

export type EnrollmentState = 'pending' | 'done' | 'cancelled' | 'declined' | 'expired' | 'failed';

export interface EnrollmentRow {
  id: string;
  orgId: string;
  mode: Mode;
  passId: string;
  scannerId: string;
  requestedBy: string;
  scope: 'pass' | 'user';
  userId: string | null;
  state: EnrollmentState;
  createdAt: number;
  expiresAt: number;
  shownAt: number | null;
  endedAt: number | null;
  bindingId: string | null;
  errorCode: string | null;
  scannerName: string;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  pass_id: string;
  scanner_id: string;
  requested_by: string;
  scope: 'pass' | 'user';
  user_id: string | null;
  state: EnrollmentState;
  created_at: number;
  expires_at: number;
  shown_at: number | null;
  ended_at: number | null;
  binding_id: string | null;
  error_code: string | null;
  scanner_name: string;
}

const SELECT = `SELECT e.id, e.org_id, e.mode, e.pass_id, e.scanner_id, e.requested_by, e.scope, e.user_id, e.state,
    e.created_at, e.expires_at, e.shown_at, e.ended_at, e.binding_id, e.error_code, s.name AS scanner_name
  FROM tag_enrollments e JOIN scanners s ON s.id = e.scanner_id`;

const toRow = (r: Raw): EnrollmentRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  passId: r.pass_id,
  scannerId: r.scanner_id,
  requestedBy: r.requested_by,
  scope: r.scope,
  userId: r.user_id,
  state: r.state,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  shownAt: r.shown_at,
  endedAt: r.ended_at,
  bindingId: r.binding_id,
  errorCode: r.error_code,
  scannerName: r.scanner_name,
});

/** An enrollment by id, before any authority exists for it. */
export async function enrollmentRow(db: Db, id: string): Promise<EnrollmentRow | null> {
  const r = await first<Raw>(db, `${SELECT} WHERE e.id = ?`, [id]);
  return r ? toRow(r) : null;
}

/** Pending requests that block a new one for this scanner or pass: expired ones are returned apart. */
export async function pendingFor(
  db: Db,
  scannerId: string,
  passId: string,
  now: number,
): Promise<{ live: EnrollmentRow[]; stale: EnrollmentRow[] }> {
  const rows = (
    await all<Raw>(
      db,
      `${SELECT} WHERE e.state = 'pending' AND (e.scanner_id = ? OR e.pass_id = ?)`,
      [scannerId, passId],
    )
  ).map(toRow);
  return {
    live: rows.filter((r) => r.expiresAt > now),
    stale: rows.filter((r) => r.expiresAt <= now),
  };
}

/** The device's open request, if any (it may be past its expiry: the caller decides). */
export async function pendingForScanner(
  db: Db,
  orgId: string,
  mode: Mode,
  scannerId: string,
): Promise<EnrollmentRow | null> {
  const r = await first<Raw>(
    db,
    `${SELECT} WHERE e.scanner_id = ? AND e.org_id = ? AND e.mode = ? AND e.state = 'pending'`,
    [scannerId, orgId, mode],
  );
  return r ? toRow(r) : null;
}

/** What the device may show of a request: the holder's name and the pass title. */
export async function deviceFacts(
  db: Db,
  e: Pick<EnrollmentRow, 'passId' | 'requestedBy'>,
): Promise<{
  holderName: string | null;
  passTitle: string | null;
  templateName: string;
  requestedByName: string | null;
  ownerId: string | null;
  ownerActive: boolean;
  credentialGeneration: number;
  deleted: boolean;
}> {
  const r = await first<{
    holder: string | null;
    title: string | null;
    template: string;
    requester: string | null;
    owner: string | null;
    status: string | null;
    gen: number;
    deleted_at: number | null;
  }>(
    db,
    `SELECT u.name AS holder, p.display_title AS title, t.name AS template,
       (SELECT r.name FROM users r WHERE r.id = ?) AS requester, p.owner_user_id AS owner, u.status AS status,
       p.credential_generation AS gen, p.deleted_at
     FROM passes p JOIN templates t ON t.id = p.template_id LEFT JOIN users u ON u.id = p.owner_user_id
     WHERE p.id = ?`,
    [e.requestedBy, e.passId],
  );
  return {
    holderName: r?.holder ?? null,
    passTitle: r?.title ?? null,
    templateName: r?.template ?? '',
    requestedByName: r?.requester ?? null,
    ownerId: r?.owner ?? null,
    ownerActive: r?.status === 'active',
    credentialGeneration: r?.gen ?? 0,
    deleted: r === null || r.deleted_at !== null,
  };
}

/** True when the pass's owner exists and is an active account. */
export async function ownerIsActive(db: Db, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const r = await first<{ status: string }>(db, 'SELECT status FROM users WHERE id = ?', [userId]);
  return r?.status === 'active';
}

/**
 * The requesting admin is still an active user with a membership in this org (made before the request) whose
 * roles grant passes:operate. Evaluated in the grant, over the actor row's org.
 */
export function requesterHolds(userId: string, requestedAt: number): Check {
  return {
    reason: 'actor',
    ok: (
      b,
    ) => `EXISTS (SELECT 1 FROM users u JOIN org_memberships m ON m.user_id = u.id AND m.org_id = a.org_id
      WHERE u.id = ${b.bind(userId)} AND u.status = 'active' AND m.revoked_at IS NULL
        AND m.created_at <= ${b.bind(requestedAt)}
        AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.type = 'text'
          AND r.value IN (SELECT value FROM json_each(${b.bind(JSON.stringify(rolesGranting('passes:operate')))}))))`,
  };
}

const SettingsSchema = ScannerSettingsSchema.pick({
  roleWithoutSignIn: true,
  staffSignIn: true,
  tags: true,
});
const STAFF_ROLES = new Set(['door', 'desk', 'manager']);

export interface ScannerFacts {
  id: string;
  name: string;
  sessionName: string | null;
  /** The role the device works at now; null when staff sign-in is on and nobody is signed in. */
  role: 'door' | 'desk' | 'manager' | null;
  assign: 'desk' | 'manager' | 'never';
  nfcTags: boolean;
  busy: boolean;
  lastUsedAt: number | null;
}

function parse(raw: string | null): z.infer<typeof SettingsSchema> | null {
  if (raw === null) return null;
  try {
    const r = SettingsSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function hasTagReading(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const c = ScanDeviceCapabilitiesSchema.safeParse(JSON.parse(raw));
    const nfc = c.success ? c.data.native?.nfc : undefined;
    return (
      !!nfc?.available && nfc.reading && nfc.formats.some((f) => f === 'tag-uid' || f === 'tag-sun')
    );
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/** The org's scan-role devices in a mode with what an enrollment needs to know of each. */
export async function enrollScanners(
  db: Db,
  orgId: string,
  mode: Mode,
  userId: string,
  now: number,
): Promise<ScannerFacts[]> {
  const rows = await all<{
    id: string;
    name: string;
    settings: string;
    session_name: string | null;
    session_settings: string | null;
    capabilities: string | null;
    staff_role: string | null;
    busy: number;
    last_used: number | null;
  }>(
    db,
    `SELECT s.id, s.name, s.settings, ss.name AS session_name, ss.settings AS session_settings, d.capabilities,
       (SELECT st.role FROM scan_staff st WHERE st.id = s.staff_id AND st.org_id = s.org_id AND st.disabled_at IS NULL) AS staff_role,
       EXISTS (SELECT 1 FROM tag_enrollments e WHERE e.scanner_id = s.id AND e.state = 'pending' AND e.expires_at > ?) AS busy,
       (SELECT max(e.created_at) FROM tag_enrollments e WHERE e.scanner_id = s.id AND e.requested_by = ?) AS last_used
     FROM scanners s
     LEFT JOIN scanning_devices d ON d.scanner_id = s.id AND d.org_id = s.org_id
     LEFT JOIN scanning_sessions ss ON ss.id = d.session_id AND ss.org_id = d.org_id AND ss.mode = d.mode
     WHERE s.org_id = ? AND s.mode = ? AND s.kind = 'device' AND s.device_role = 'scan' AND s.revoked_at IS NULL
     ORDER BY s.name COLLATE NOCASE, s.id LIMIT 200`,
    [now, userId, orgId, mode],
  );
  return rows.map((r) => {
    const settings = parse(r.session_settings ?? r.settings);
    const role = settings?.staffSignIn
      ? STAFF_ROLES.has(r.staff_role ?? '')
        ? (r.staff_role as 'door' | 'desk' | 'manager')
        : null
      : (settings?.roleWithoutSignIn ?? 'door');
    return {
      id: r.id,
      name: r.name,
      sessionName: r.session_name,
      role,
      assign: settings?.tags?.assign ?? 'desk',
      nfcTags: hasTagReading(r.capabilities),
      busy: r.busy === 1,
      lastUsedAt: r.last_used,
    };
  });
}
