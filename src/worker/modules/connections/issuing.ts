import { ForbiddenError } from '../../platform/errors.ts';
import { rolesGranting } from '../orgs/access.ts';
import type { ConnectionAuthority } from './access.ts';
import type { ConnectionRow } from './repo.ts';
import { hasBoundPasses } from './repo-stats.ts';
import type { CreateInput, UpdateInput } from './service-shared.ts';

/**
 * A sync issues, mails, rewrites and voids passes on its own, so what it issues is pass work: it needs pass
 * rights on top of integrations:manage. Two kinds of change count. (1) Turning issuing up: the switches below.
 * (2) Changing where an armed connection reads from or who it reads for (config, secrets, webhook secret,
 * mode, holder email field, re-enabling, rotating the secret): whoever controls the source controls the passes.
 * Changes that only reduce issuing (switches off, `flag`, disabling) need no pass rights.
 */
type IssuingInput = Pick<
  CreateInput,
  'autoCreate' | 'autoEmail' | 'defaultTemplateId' | 'mapping' | 'onMissing' | 'voidWhen'
>;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A new connection sets a switch away from its default (off, none, `flag`). */
export function createIssues(input: IssuingInput): boolean {
  return (
    input.autoCreate === true ||
    input.autoEmail === true ||
    input.defaultTemplateId !== undefined ||
    input.mapping !== undefined ||
    (input.voidWhen?.length ?? 0) > 0 ||
    (input.onMissing !== undefined && input.onMissing !== 'flag')
  );
}

/** A patch turns issuing up. Resending a stored value, or reducing issuing, is not a change. */
function switchesUp(input: UpdateInput, conn: ConnectionRow): boolean {
  return (
    (input.autoCreate === true && !conn.autoCreate) ||
    (input.autoEmail === true && !conn.autoEmail) ||
    (input.defaultTemplateId !== undefined && input.defaultTemplateId !== conn.defaultTemplateId) ||
    (input.mapping !== undefined && !same(input.mapping, conn.mapping)) ||
    (input.voidWhen !== undefined &&
      input.voidWhen.length > 0 &&
      !same(input.voidWhen, conn.voidWhen)) ||
    (input.onMissing !== undefined &&
      input.onMissing !== conn.onMissing &&
      input.onMissing !== 'flag')
  );
}

/** A patch moves the source of an armed connection. */
function sourceChanges(input: UpdateInput, conn: ConnectionRow): boolean {
  return (
    (input.config !== undefined && !same(input.config, conn.config)) ||
    input.secrets !== undefined ||
    input.webhookSecret !== undefined ||
    (input.mode !== undefined && input.mode !== conn.mode) ||
    (input.holderEmailField !== undefined && input.holderEmailField !== conn.holderEmailField) ||
    (input.enabled === true && !conn.enabled)
  );
}

/** Armed: a sync would issue or mail new passes, void missing ones, or touch passes already bound to it. */
export async function isArmed(db: D1Database, conn: ConnectionRow): Promise<boolean> {
  return (
    conn.autoCreate ||
    conn.autoEmail ||
    conn.onMissing === 'void' ||
    conn.voidWhen.length > 0 ||
    (await hasBoundPasses(db, conn.id))
  );
}

/** Whether this patch needs pass rights. Reads the bindings only when a source change makes it matter. */
export async function updateIssues(
  db: D1Database,
  input: UpdateInput,
  conn: ConnectionRow,
): Promise<boolean> {
  if (switchesUp(input, conn)) return true;
  return sourceChanges(input, conn) && (await isArmed(db, conn));
}

const PASS_OPERATE_ROLES: readonly string[] = rolesGranting('passes:operate');

/** Pass rights: passes:operate for a session, passes:write for a key. */
export function assertMayIssue(authority: ConnectionAuthority | undefined): void {
  if (!authority) return;
  const ok =
    authority.kind === 'session'
      ? authority.roles.some((role) => PASS_OPERATE_ROLES.includes(role))
      : authority.scopes.includes('passes:write');
  if (!ok) {
    throw new ForbiddenError(
      'This connection issues passes, so this change needs pass rights: ask a pass operator or an organization admin.',
      'MISSING_SCOPE',
    );
  }
}
