// The KEK re-wrap statements of wallet_google_messages (0197), kept apart so repo-rewrap.ts stays under the size limit.

/** x1 is the instance: the AAD google-message-seal.ts sealed the row under. */
export const GOOGLE_MESSAGES_SELECT = `SELECT t.id AS pk, t.kek_version, t.wrapped_dek, t.instance_id AS x1, NULL AS x2, NULL AS x3, NULL AS x4
    FROM wallet_google_messages t WHERE t.id > ? AND t.kek_version < ? ORDER BY t.id LIMIT ?`;

export const GOOGLE_MESSAGES_UPDATE = `UPDATE wallet_google_messages SET kek_version = ?, wrapped_dek = ?
       WHERE id = ? AND kek_version = ? AND wrapped_dek = ? RETURNING id`;
