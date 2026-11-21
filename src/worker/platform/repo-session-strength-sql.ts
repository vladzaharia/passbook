import { STRONG_AMR } from '../../shared/sign-in.ts';

/**
 * The SQL backstop of the sign-in rule: a session grants console authority only when it is strong
 * (`oidc`, `breakglass`) or an email session inside the grace window, whatever route guard let it in.
 */
export const STRONG_AMR_SQL = `(${STRONG_AMR.map((amr) => `'${amr}'`).join(', ')})`;

/**
 * `alias` is a `sessions` row. `now` is the placeholder for the time in ms.
 * Grace: the user is in `console_email_grace` and `auth.consoleEmailUntil` has not passed.
 */
export const consoleSessionSql = (alias: string, now = '?'): string =>
  `(${alias}.amr IN ${STRONG_AMR_SQL} OR (${alias}.amr = 'magic_link'
    AND EXISTS (SELECT 1 FROM console_email_grace g WHERE g.user_id = ${alias}.user_id)
    AND ${now} < COALESCE((SELECT json_extract(st.value, '$') FROM settings st
      WHERE st.scope = 'platform' AND st.key = 'auth.consoleEmailUntil'), 0)))`;
