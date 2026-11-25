// 0211: passes_lent_tags_end ends the pass bindings of loaner tags (type use 'visitor') when their pass is
// voided or removed, and nothing else.
import { describe, expect, it } from 'vitest';
import { tagWorld } from './nfc-tags-fixtures.ts';
import { migrationFile, read } from './wallet-instances-fixtures.ts';

const { db, rolledBack, sql, type, tag, bind } = tagWorld();
db.exec(read(migrationFile('0211')));

type Row = { end_cause: string | null; ended_by: string | null; ended_by_type: string | null };
const ended = (id: string) =>
  db
    .prepare('SELECT end_cause, ended_by, ended_by_type FROM tag_bindings WHERE id = ?')
    .get(id) as Row;
const STILL = { end_cause: null, ended_by: null, ended_by_type: null };
const ENDED = { end_cause: 'pass_ended', ended_by: 'passes', ended_by_type: 'system' };

/** A loaner and a member tag bound to p3, and a loaner on p4. */
function world() {
  type('v', { use: 'visitor', scopes: 'pass', per_pass: 3 });
  type('m', { use: 'member', per_pass: 3 });
  tag('lv', { type_id: 'v' });
  tag('mv', { type_id: 'm' });
  tag('std');
  tag('lv4', { type_id: 'v' });
  bind('b-lv', 'lv');
  bind('b-mv', 'mv');
  bind('b-std', 'std');
  bind('b-lv4', 'lv4', { pass_id: 'p4' });
}

describe('passes_lent_tags_end', () => {
  it('void ends only the loaner binding of that pass', () => {
    rolledBack(() => {
      world();
      sql("UPDATE passes SET status = 'voided' WHERE id = 'p3'");
      expect(ended('b-lv')).toEqual(ENDED);
      expect(ended('b-mv')).toEqual(STILL);
      expect(ended('b-std')).toEqual(STILL);
      expect(ended('b-lv4')).toEqual(STILL);
    });
  });

  it('remove ends it too', () => {
    rolledBack(() => {
      world();
      sql("UPDATE passes SET removed_at = 5 WHERE id = 'p3'");
      expect(ended('b-lv')).toEqual(ENDED);
      expect(ended('b-mv')).toEqual(STILL);
    });
  });

  it('does not fire for other updates, or for un-void and un-remove', () => {
    rolledBack(() => {
      world();
      sql("UPDATE passes SET status = 'active', removed_at = NULL WHERE id = 'p3'");
      sql("UPDATE passes SET holder_email = NULL, modified_at = 9 WHERE id = 'p3'");
      expect(ended('b-lv')).toEqual(STILL);
    });
  });

  it('a binding that already ended keeps its own cause', () => {
    rolledBack(() => {
      world();
      sql(
        "UPDATE tag_bindings SET ended_at = 8, ended_by_type = 'staff', ended_by = 'x', end_cause = 'admin' WHERE id = 'b-lv'",
      );
      sql("UPDATE passes SET status = 'voided' WHERE id = 'p3'");
      expect(ended('b-lv')).toEqual({ end_cause: 'admin', ended_by: 'x', ended_by_type: 'staff' });
    });
  });

  it('is idempotent: removing a voided pass, or voiding it again, keeps the first end', () => {
    rolledBack(() => {
      world();
      sql("UPDATE passes SET status = 'voided' WHERE id = 'p3'");
      const first = db.prepare("SELECT ended_at FROM tag_bindings WHERE id = 'b-lv'").get();
      sql("UPDATE passes SET removed_at = 5, status = 'voided' WHERE id = 'p3'");
      sql("UPDATE passes SET removed_at = 6 WHERE id = 'p3'");
      expect(db.prepare("SELECT ended_at FROM tag_bindings WHERE id = 'b-lv'").get()).toEqual(
        first,
      );
      expect(ended('b-lv')).toEqual(ENDED);
    });
  });

  it('a loaner lent again after the void is not ended by an unrelated update', () => {
    rolledBack(() => {
      world();
      sql("UPDATE passes SET status = 'voided' WHERE id = 'p3'");
      bind('b-lv-2', 'lv');
      sql("UPDATE passes SET status = 'voided', modified_at = 12 WHERE id = 'p3'");
      expect(ended('b-lv-2')).toEqual(STILL);
    });
  });

  it('only pass-scope bindings of the voided pass: a person-wide binding anchored there is not touched', () => {
    rolledBack(() => {
      world();
      tag('person', { type_id: 'm' });
      bind('b-user', 'person', { scope: 'user', pass_id: 'p2', user_id: 'u1' });
      sql("UPDATE passes SET status = 'voided' WHERE id = 'p2'");
      expect(ended('b-user')).toEqual(STILL);
    });
  });
});

describe('tag_bindings_expiry_fixed', () => {
  const move = () => sql("UPDATE tag_bindings SET expires_at = 99999999999999 WHERE id = 'b-lv'");

  it("moves a loaner's expiry, and fixes every other binding's", () => {
    rolledBack(() => {
      world();
      move();
      expect(() =>
        sql("UPDATE tag_bindings SET expires_at = 99999999999999 WHERE id = 'b-mv'"),
      ).toThrow(/tag_binding_immutable/);
    });
  });

  it("matches the type by org: a tag on another org's visitor type stays fixed", () => {
    rolledBack(() => {
      world();
      type('v-other', { org_id: 'o2', use: 'visitor', scopes: 'pass' });
      // The tenant trigger already refuses this row; drop it to prove the expiry rule holds alone.
      sql('DROP TRIGGER nfc_tags_type_update');
      sql("UPDATE nfc_tags SET type_id = 'v-other' WHERE id = 'lv'");
      expect(move).toThrow(/tag_binding_immutable/);
    });
  });
});
