/**
 * A scalar SQL expression labelling a user for a tenant response: the user's name, else the email the org
 * knows them by (the invitation their membership came from), else "Account". `users.primary_email` is
 * account data that can belong to another org's member or link an alias to the account, so only a platform
 * administrator's response (`platform`) falls back to it. `user` and `org` are SQL expressions of the query.
 */
export function userLabelSql(user: string, org: string, platform: boolean): string {
  const known = platform
    ? 'u.primary_email'
    : `COALESCE((SELECT i.email FROM org_memberships m JOIN org_invitations i ON i.id = m.invitation_id
         WHERE m.user_id = u.id AND m.org_id = ${org} ORDER BY m.created_at DESC LIMIT 1), 'Account')`;
  return `(SELECT COALESCE(NULLIF(trim(u.name), ''), ${known}) FROM users u WHERE u.id = ${user})`;
}
