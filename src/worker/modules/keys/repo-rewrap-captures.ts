import { all, batch, stmt } from '../../platform/db.ts';

// Captured test emails keep the envelope packed in the body: `enc1:<kek>.<iv>.<wrapped DEK>.<ciphertext>`.

export interface RawCapture {
  pk: string;
  org_id: string;
  html: string | null;
  text: string | null;
}

/** The first 200 characters of each sealed body hold the whole header (kek, iv, wrapped DEK). */
export const CAPTURE_HEAD = 200;

export function selectCaptures(
  db: D1Database,
  after: string | null,
  current: number,
  limit: number,
): Promise<RawCapture[]> {
  return all<RawCapture>(
    db,
    `SELECT t.id AS pk, t.org_id,
       CASE WHEN t.html GLOB 'enc1:*' THEN substr(t.html, 1, ${CAPTURE_HEAD}) END AS html,
       CASE WHEN t.text GLOB 'enc1:*' THEN substr(t.text, 1, ${CAPTURE_HEAD}) END AS text
     FROM captured_emails t
     WHERE t.id > ?
       AND ((t.html GLOB 'enc1:*' AND CAST(substr(t.html, 6, instr(t.html, '.') - 6) AS INTEGER) < ?)
         OR (t.text GLOB 'enc1:*' AND CAST(substr(t.text, 6, instr(t.text, '.') - 6) AS INTEGER) < ?))
     ORDER BY t.id LIMIT ?`,
    [after ?? '', current, current, limit],
  );
}

/** A capture's move: each column's header as read and its replacement ('' for a column left alone). */
export interface CaptureMove {
  pk: string;
  html: { from: string; to: string };
  text: { from: string; to: string };
}

/** Replaces the headers in place; the body is never read or bound. A forward in flight locks the row. */
export async function moveCaptures(db: D1Database, moves: readonly CaptureMove[]): Promise<number> {
  const results = await batch(
    db,
    moves.map((m) =>
      stmt(
        db,
        `UPDATE captured_emails SET html = ? || substr(html, ?), text = ? || substr(text, ?)
         WHERE id = ? AND substr(html, 1, ?) = ? AND substr(text, 1, ?) = ?
           AND NOT EXISTS (SELECT 1 FROM sandbox_forwards f
             WHERE f.capture_id = captured_emails.id AND f.state IN ('sending', 'unknown'))
         RETURNING id`,
        [
          m.html.to,
          m.html.from.length + 1,
          m.text.to,
          m.text.from.length + 1,
          m.pk,
          m.html.from.length,
          m.html.from,
          m.text.from.length,
          m.text.from,
        ],
      ),
    ),
  );
  return results.reduce((n, r) => n + (r.results?.length ?? 0), 0);
}
