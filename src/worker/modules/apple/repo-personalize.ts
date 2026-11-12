import { grant } from '../../platform/authority.ts';
import { rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { tenantSql } from '../../platform/authority-cond.ts';
import { writePart } from '../../platform/authority-include.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { first } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import {
  type AppleCredential,
  appleCredentialParams,
  appleCredentialSql,
  devicePrincipal,
} from './repo-credential.ts';

export interface PersonalizationRow {
  passId: string;
  tokenSha256: string;
  publishedAt: number | null;
}

export async function getPersonalization(
  db: D1Database,
  passId: string,
): Promise<PersonalizationRow | null> {
  const row = await first<{ pass_id: string; token_sha256: string; published_at: number | null }>(
    db,
    'SELECT pass_id, token_sha256, published_at FROM pass_personalizations WHERE pass_id = ?',
    [passId],
  );
  return row
    ? { passId: row.pass_id, tokenSha256: row.token_sha256, publishedAt: row.published_at }
    : null;
}

export async function isPersonalized(db: D1Database, passId: string): Promise<boolean> {
  return (await getPersonalization(db, passId)) !== null;
}

/** Personalization is an unauthenticated serial capability, so its snapshot must still be live. */
export async function personalizationCredentialCurrent(
  db: D1Database,
  pass: AppleCredential,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM passes p WHERE ${appleCredentialSql}
       AND p.deleted_at IS NULL AND p.status = 'active'`,
      appleCredentialParams(pass),
    )) !== null
  );
}

export async function getCredentialPersonalization(
  db: D1Database,
  pass: AppleCredential,
): Promise<PersonalizationRow | null> {
  const row = await first<{ pass_id: string; token_sha256: string; published_at: number | null }>(
    db,
    `SELECT s.pass_id, s.token_sha256, s.published_at FROM pass_personalizations s
     WHERE s.pass_id = ? AND EXISTS (SELECT 1 FROM passes p WHERE ${appleCredentialSql}
       AND p.deleted_at IS NULL AND p.status = 'active')`,
    [pass.id, ...appleCredentialParams(pass)],
  );
  return row
    ? { passId: row.pass_id, tokenSha256: row.token_sha256, publishedAt: row.published_at }
    : null;
}

const STALE = 'CREDENTIAL_STALE';

/** The device's grant: it proves the captured credential at commit and may write only this pass's personalization. */
function deviceGrant(ctx: ServiceContext, pass: AppleCredential) {
  return grant(ctx, {
    purpose: 'org_mode.pass.personalize',
    principal: devicePrincipal(pass),
    target: pass.id,
    checks: [
      rowIs('passes', pass.id, { deleted_at: null }, 'lineage'),
      rawCheck(
        'lineage',
        "NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')",
        [pass.id],
      ),
    ],
    codes: { actor: STALE, org: STALE, lineage: STALE },
    tables: ['pass_personalizations'],
  });
}

/** A refused device proof (rotated token, transfer, suspended org) is "not current", not an error. */
async function commitDevice(g: ReturnType<typeof deviceGrant>) {
  try {
    return await g.commit();
  } catch (error) {
    if (error instanceof AppError && error.code === STALE) return null;
    throw error;
  }
}

/** Store personalization and its audit together only for the captured live credential. */
export async function insertPersonalization(
  ctx: ServiceContext,
  r: {
    pass: AppleCredential;
    tokenSha256: string;
    envelope: Envelope;
    now: number;
    fields: string[];
  },
): Promise<void> {
  const g = deviceGrant(ctx, r.pass);
  g.include(
    writePart(
      `INSERT OR IGNORE INTO pass_personalizations
         (pass_id, token_sha256, kek_version, iv, wrapped_dek, ciphertext, created_at)
       SELECT {pass}, ?, ?, ?, ?, ?, ? WHERE {grant}`,
      [
        r.tokenSha256,
        r.envelope.kekVersion,
        r.envelope.iv,
        r.envelope.wrappedDek,
        r.envelope.ciphertext,
        r.now,
      ],
    ),
  );
  grantedAudit(
    g,
    ctx,
    {
      orgId: r.pass.orgId,
      actorType: 'device',
      action: 'pass.personalized',
      targetType: 'pass',
      targetId: r.pass.id,
      detail: { fields: r.fields },
    },
    [
      tenantSql(
        'EXISTS (SELECT 1 FROM pass_personalizations s WHERE s.pass_id = ? AND s.token_sha256 = ?)',
        [r.pass.id, r.tokenSha256],
      ),
    ],
  );
  await commitDevice(g);
}

export async function markPersonalizationPublished(
  ctx: ServiceContext,
  pass: AppleCredential,
  tokenSha256: string,
): Promise<boolean> {
  const g = deviceGrant(ctx, pass);
  g.include(
    writePart(
      'UPDATE pass_personalizations SET published_at = ? WHERE pass_id = {pass} AND token_sha256 = ? AND {grant} RETURNING pass_id',
      [ctx.clock.now(), tokenSha256],
    ),
  );
  const result = await commitDevice(g);
  return (result?.[0]?.results?.length ?? 0) === 1;
}
