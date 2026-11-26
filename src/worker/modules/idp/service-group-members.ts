import type { CreateGroupMember, GroupMember } from '../../../shared/contracts/idp-access.ts';
import { batch, classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { requireUser } from '../users/service.ts';
import { idpClient } from './client.ts';
import { isPlatformAdmin } from './desired.ts';
import { toMember } from './dto-groups.ts';
import {
  insertMemberStmt,
  liveMembersOfGroup,
  memberById,
  removeMemberStmt,
} from './repo-group-members.ts';
import { identityOfSubject, subjectsOfUser } from './repo-sources.ts';
import { requireLiveGroup } from './service-group-rules.ts';

const refused = () =>
  new ConflictError("This account can't be added to a group here.", 'IDP_REFUSED');

/** One Polaris ID account per user: with none or several, a member has no single subject. */
async function subjectOfUser(ctx: ServiceContext, userId: string): Promise<string> {
  await requireUser(ctx, userId);
  const subjects = await subjectsOfUser(ctx.env.DB, userId);
  const [subject] = subjects;
  if (!subject || subjects.length > 1)
    throw new ConflictError(
      subject ? 'This user has several Polaris ID accounts.' : "This user isn't in Polaris ID.",
      subject ? 'IDP_MULTIPLE_ACCOUNTS' : 'IDP_NO_ACCOUNT',
    );
  return subject;
}

export async function listMembers(ctx: ServiceContext, key: string): Promise<GroupMember[]> {
  await requireLiveGroup(ctx.env.DB, key);
  return (await liveMembersOfGroup(ctx.env.DB, key)).map(toMember);
}

export async function addMember(
  ctx: ServiceContext,
  actorId: string,
  key: string,
  input: CreateGroupMember,
): Promise<GroupMember> {
  const db = ctx.env.DB;
  await requireLiveGroup(db, key);
  const subject = 'userId' in input ? await subjectOfUser(ctx, input.userId) : input.subject;
  // Polaris ID admins and platform admins are never PassBook-managed members: the binding refuses them.
  const identity = await identityOfSubject(db, subject);
  if (identity && isPlatformAdmin(identity.last_roles)) throw refused();
  if ((await idpClient(ctx.env, ctx.log).lookup(subject)).isAdmin) throw refused();
  if ((await liveMembersOfGroup(db, key)).some((m) => m.subject === subject))
    throw new ConflictError('This account is already a member.', 'IDP_MEMBER_EXISTS');
  const id = ctx.ids.id();
  try {
    await batch(db, [
      insertMemberStmt(db, {
        id,
        groupKey: key,
        subject,
        userId: identity?.user_id ?? null,
        platformInvitationId: null,
        addedBy: actorId,
        now: ctx.clock.now(),
      }),
      auditStmt(db, ctx, {
        actorType: 'user',
        actorId,
        action: 'idp.group_member',
        targetType: 'idp_group',
        targetId: key,
        detail: { op: 'add', memberId: id, userId: identity?.user_id ?? null },
      }),
    ]);
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique')
      throw new ConflictError('This account is already a member.', 'IDP_MEMBER_EXISTS');
    throw error;
  }
  ctx.log.info('idp.group_member', { key, op: 'add' });
  const row = await memberById(db, id);
  if (!row) throw new NotFoundError('Member not found.', 'MEMBER_NOT_FOUND');
  return toMember(row);
}

export async function removeMember(
  ctx: ServiceContext,
  actorId: string,
  key: string,
  memberId: string,
): Promise<void> {
  const db = ctx.env.DB;
  const member = await memberById(db, memberId);
  if (!member || member.group_key !== key || member.removed_at !== null)
    throw new NotFoundError('Member not found.', 'MEMBER_NOT_FOUND');
  await batch(db, [
    removeMemberStmt(db, memberId, actorId, ctx.clock.now()),
    auditStmt(db, ctx, {
      actorType: 'user',
      actorId,
      action: 'idp.group_member',
      targetType: 'idp_group',
      targetId: key,
      detail: { op: 'remove', memberId, userId: member.user_id },
    }),
  ]);
  ctx.log.info('idp.group_member', { key, op: 'remove' });
}
