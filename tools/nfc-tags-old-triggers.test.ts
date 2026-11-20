// The 0088-0097 rules on the tables 0128 rebuilt: the same refusals, cascades and fences as before.
import { describe, expect, it } from 'vitest';
import { tagWorld } from './nfc-tags-fixtures.ts';

const refuses = (fn: () => void, message: RegExp) => expect(fn).toThrow(message);
const { db, rolledBack, sql, tag, bind } = tagWorld();

describe('the 0088-0097 rules on the rebuilt tables', () => {
  it('refuses a retired, lost, cross-tenant or fifth binding and a fixed-column update', () => {
    rolledBack(() => {
      tag('r');
      sql("UPDATE nfc_tags SET status = 'retired' WHERE id = 'r'");
      refuses(() => bind('x', 'r'), /tag_retired/);
      tag('l', { lost_at: 1, lost_by: 'x' });
      refuses(() => bind('x', 'l'), /tag_lost/);
      tag('o');
      refuses(() => bind('x', 'o', { pass_id: 'po2' }), /tag_binding_tenant/);
      refuses(() => sql("UPDATE nfc_tags SET hint = 'FFFF' WHERE id = 'o'"), /tag_fixed_columns/);
      refuses(() => sql("UPDATE nfc_tags SET org_id = 'o2' WHERE id = 'o'"), /tag_fixed_columns/);
      refuses(
        () => bind('x', 'o', { scope: 'user', pass_id: 'p3', user_id: 'u1' }),
        /tag_binding_owner/,
      );
    });
  });

  it('retire ends the binding, lost marks the tag, a pass delete ends its bindings, a tag delete cascades', () => {
    rolledBack(() => {
      tag('a');
      bind('ba', 'a');
      sql("UPDATE nfc_tags SET status = 'retired' WHERE id = 'a'");
      expect(db.prepare("SELECT end_cause FROM tag_bindings WHERE id = 'ba'").get()).toEqual({
        end_cause: 'tag_retired',
      });
      tag('b');
      bind('bb', 'b');
      refuses(
        () =>
          sql(
            "UPDATE tag_bindings SET ended_at = 9, ended_by_type = 'staff', end_cause = 'lost' WHERE id = 'bb'",
          ),
        /tag_lost_needs_actor/,
      );
      sql(
        "UPDATE tag_bindings SET ended_at = 9, ended_by_type = 'staff', ended_by = 'x', end_cause = 'lost' WHERE id = 'bb'",
      );
      expect(db.prepare("SELECT lost_by FROM nfc_tags WHERE id = 'b'").get()).toEqual({
        lost_by: 'x',
      });
      tag('c');
      bind('bc', 'c', { pass_id: 'p4' });
      sql("UPDATE passes SET deleted_at = 9 WHERE id = 'p4'");
      expect(db.prepare("SELECT end_cause FROM tag_bindings WHERE id = 'bc'").get()).toEqual({
        end_cause: 'pass_deleted',
      });
    });
  });

  it('keeps the enrollment fences and the cascade from tag to binding to enrollment', () => {
    refuses(
      () => sql("UPDATE tag_enrollments SET state = 'done' WHERE id = 'e3'"),
      /enrollment_immutable/,
    );
    refuses(
      () => sql("UPDATE tag_enrollments SET expires_at = 21 WHERE id = 'e2'"),
      /enrollment_immutable/,
    );
    rolledBack(() => {
      sql("DELETE FROM nfc_tags WHERE id = 'tg1'");
      expect(db.prepare("SELECT count(*) AS n FROM tag_bindings WHERE id = 'b1'").get()).toEqual({
        n: 0,
      });
      expect(db.prepare("SELECT binding_id FROM tag_enrollments WHERE id = 'e1'").get()).toEqual({
        binding_id: null,
      });
    });
  });
});
