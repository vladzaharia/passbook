import { PlainLineSchema } from '../../../shared/contracts/common.ts';
import { PERSONAL_ORG_COPY } from '../../../shared/copy/personal-org.ts';

const NAME = PlainLineSchema(120);
// "personal-" plus a body and a "-NN" suffix stay inside the 64-character slug limit.
const BODY_MAX = 48;

interface PersonalSource {
  id: string;
  name: string | null;
  /** The verified address, or null: never the no-verified-email placeholder. */
  email: string | null;
}

/** The user's name, else the local part of their known email, else `User <id prefix>`. */
export function personalOrgName(user: PersonalSource): string {
  const local = user.email?.slice(0, Math.max(0, user.email.lastIndexOf('@')));
  for (const candidate of [user.name, local]) {
    const parsed = NAME.safeParse(candidate?.slice(0, 120) ?? '');
    if (parsed.success) return parsed.data;
  }
  return `User ${user.id.slice(0, 8)}`;
}

function slugBody(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BODY_MAX)
    .replace(/-+$/, '');
}

/**
 * `personal-<name>`, with `-2`, `-3`, ... from the second attempt on a collision. The `last` attempt
 * ends in the user's id instead, which no other user shares.
 */
export function personalOrgSlug(name: string, userId: string, attempt = 1, last = false): string {
  const body = slugBody(name) || slugBody(userId).slice(0, 8);
  const base = `${PERSONAL_ORG_COPY.slugPrefix}${body}`;
  if (last) return `${base.slice(0, 42).replace(/-+$/, '')}-${slugBody(userId).slice(-12)}`;
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

/** What a viewer sees as the org's name: their own personal org is "Personal"; anyone else sees the stored name. */
export function viewerOrgName(
  org: { name: string; personal_user_id: string | null },
  viewerId: string,
): string {
  return org.personal_user_id === viewerId ? PERSONAL_ORG_COPY.label : org.name;
}
