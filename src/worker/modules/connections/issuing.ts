import { ForbiddenError } from '../../platform/errors.ts';
import { rolesGranting } from '../orgs/access.ts';
import type { ConnectionAuthority } from './access.ts';
import type { ConnectionRow } from './repo.ts';
import type { CreateInput, UpdateInput } from './service-shared.ts';

/** The issuing switches decide which passes a sync creates, mails, rewrites or voids. */
type IssuingInput = Pick<
  CreateInput,
  'autoCreate' | 'autoEmail' | 'defaultTemplateId' | 'mapping' | 'onMissing'
>;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A new connection sets a switch away from its default (off, none, `flag`). */
export function createIssues(input: IssuingInput): boolean {
  return (
    input.autoCreate === true ||
    input.autoEmail === true ||
    input.defaultTemplateId !== undefined ||
    input.mapping !== undefined ||
    (input.onMissing !== undefined && input.onMissing !== 'flag')
  );
}

/** A patch changes a switch's stored value; resending the current value is not a change. */
export function updateIssues(input: UpdateInput, conn: ConnectionRow): boolean {
  return (
    (input.autoCreate !== undefined && input.autoCreate !== conn.autoCreate) ||
    (input.autoEmail !== undefined && input.autoEmail !== conn.autoEmail) ||
    (input.defaultTemplateId !== undefined && input.defaultTemplateId !== conn.defaultTemplateId) ||
    (input.mapping !== undefined && !same(input.mapping, conn.mapping)) ||
    (input.onMissing !== undefined && input.onMissing !== conn.onMissing)
  );
}

const PASS_OPERATE_ROLES: readonly string[] = rolesGranting('passes:operate');

/** Issuing needs pass rights on top of integrations:manage: passes:operate for a session, passes:write for a key. */
export function assertMayIssue(authority: ConnectionAuthority | undefined): void {
  if (!authority) return;
  const ok =
    authority.kind === 'session'
      ? authority.roles.some((role) => PASS_OPERATE_ROLES.includes(role))
      : authority.scopes.includes('passes:write');
  if (!ok) {
    throw new ForbiddenError(
      'Changing what a connection issues needs pass rights too.',
      'MISSING_SCOPE',
    );
  }
}
