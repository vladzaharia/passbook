// The new triggers of 0128: every refusal of the type and system rules, and the cases that must still pass
// (Standard tags, an archived type's existing tags, the four new end causes).
import { describe, expect, it } from 'vitest';
import { tagWorld } from './nfc-tags-fixtures.ts';

const refuses = (fn: () => void, message: RegExp) => expect(fn).toThrow(message);
const { rolledBack, sql, enableSun, type, tag, bind } = tagWorld();

describe('systems', () => {
  it('refuses a tag or a type of a system that is off', () => {
    rolledBack(() => {
      refuses(() => tag('x', { system: 'sun' }), /tag_system_disabled/);
      refuses(() => type('y', { system: 'sun' }), /tag_system_disabled/);
      refuses(() => tag('x', { system: 'nope' }), /tag_system_disabled/);
      enableSun();
      tag('x', { system: 'sun' });
      type('y', { system: 'sun', use: 'staff' });
    });
  });

  it('never changes a tag or type system', () => {
    rolledBack(() => {
      enableSun();
      type('y');
      tag('x', { type_id: 'y' });
      refuses(() => sql("UPDATE nfc_tags SET system = 'sun' WHERE id = 'x'"), /tag_fixed_columns/);
      refuses(
        () => sql("UPDATE nfc_tag_types SET system = 'sun', version = 2 WHERE id = 'y'"),
        /tag_type_fixed/,
      );
    });
  });

  it('a type and its tag share a system', () => {
    rolledBack(() => {
      enableSun();
      type('y');
      refuses(() => tag('x', { system: 'sun', type_id: 'y' }), /tag_type_system/);
    });
  });
});

describe('read-only systems, template links and expiry', () => {
  it('refuses any write to nfc_tag_systems', () => {
    refuses(
      () => sql("UPDATE nfc_tag_systems SET enabled = 1 WHERE id = 'sun'"),
      /tag_system_fixed/,
    );
    refuses(() => sql("DELETE FROM nfc_tag_systems WHERE id = 'sun'"), /tag_system_fixed/);
    refuses(
      () =>
        sql("INSERT INTO nfc_tag_systems (id, assurance, enabled) VALUES ('desfire', 'secure', 1)"),
      /tag_system_fixed/,
    );
  });

  it('refuses deleting a template a type names, and an update of a template link', () => {
    rolledBack(() => {
      type('y');
      sql("INSERT INTO nfc_tag_type_templates (type_id, template_id) VALUES ('y', 't2-o1')");
      refuses(() => sql("DELETE FROM templates WHERE id = 't2-o1'"), /FOREIGN KEY/);
      refuses(
        () => sql("UPDATE nfc_tag_type_templates SET template_id = 't2-o2' WHERE type_id = 'y'"),
        /tag_type_fixed/,
      );
      sql("DELETE FROM nfc_tag_type_templates WHERE type_id = 'y'");
      sql("DELETE FROM templates WHERE id = 't2-o1'");
    });
  });

  it('an expiry must be after the binding', () => {
    rolledBack(() => {
      tag('x');
      refuses(() => bind('bx', 'x', { expires_at: 7 }), /CHECK/);
      bind('bx', 'x', { expires_at: 8 });
    });
  });
});

describe('type rows', () => {
  it('holds org, creation and the version', () => {
    rolledBack(() => {
      type('y');
      for (const set of ["org_id = 'o2'", "created_by = 'z'", 'created_at = 2'])
        refuses(
          () => sql(`UPDATE nfc_tag_types SET ${set}, version = 2 WHERE id = 'y'`),
          /tag_type_fixed/,
        );
      refuses(() => sql("UPDATE nfc_tag_types SET name = 'z' WHERE id = 'y'"), /tag_type_version/);
      refuses(
        () => sql("UPDATE nfc_tag_types SET name = 'z', version = 3 WHERE id = 'y'"),
        /tag_type_version/,
      );
      sql("UPDATE nfc_tag_types SET name = 'z', version = 2 WHERE id = 'y'");
      sql("UPDATE nfc_tag_types SET archived_at = 5, version = 3 WHERE id = 'y'");
    });
  });

  it('keeps one active name per org, and lets an archived name go', () => {
    rolledBack(() => {
      type('a', { name: 'Wristband' });
      refuses(() => type('b', { name: 'Wristband' }), /UNIQUE/);
      sql("UPDATE nfc_tag_types SET archived_at = 5, version = 2 WHERE id = 'a'");
      type('b', { name: 'Wristband' });
    });
  });
});

describe('tag type tenant, archive and template rows', () => {
  it('refuses a type of another org, on insert and on update', () => {
    rolledBack(() => {
      type('y2', { org_id: 'o2' });
      refuses(() => tag('x', { type_id: 'y2' }), /tag_type_tenant/);
      tag('x');
      refuses(() => sql("UPDATE nfc_tags SET type_id = 'y2' WHERE id = 'x'"), /tag_type_tenant/);
    });
  });

  it('refuses an archived type for a new tag or a new type on a tag; existing tags keep theirs', () => {
    rolledBack(() => {
      type('y');
      tag('keep', { type_id: 'y' });
      type('old', { archived_at: 5 });
      refuses(() => tag('x', { type_id: 'old' }), /tag_type_archived/);
      tag('x');
      refuses(() => sql("UPDATE nfc_tags SET type_id = 'old' WHERE id = 'x'"), /tag_type_archived/);
      sql("UPDATE nfc_tag_types SET archived_at = 5, version = 2 WHERE id = 'y'");
      sql("UPDATE nfc_tags SET label = 'still fine' WHERE id = 'keep'");
      bind('bk', 'keep');
      sql("UPDATE nfc_tags SET type_id = NULL WHERE id = 'keep'");
    });
  });

  it('a template row needs a template of the type org', () => {
    rolledBack(() => {
      type('y');
      sql("INSERT INTO nfc_tag_type_templates (type_id, template_id) VALUES ('y', 't2-o1')");
      refuses(
        () =>
          sql("INSERT INTO nfc_tag_type_templates (type_id, template_id) VALUES ('y', 't2-o2')"),
        /tag_type_tenant/,
      );
      refuses(
        () => sql("INSERT INTO nfc_tag_type_templates (type_id, template_id) VALUES ('y', 'nope')"),
        /tag_type_tenant/,
      );
    });
  });
});

describe('binding rules of a typed tag', () => {
  it('refuses the scope a type does not allow', () => {
    rolledBack(() => {
      type('p', { scopes: 'pass' });
      type('u', { scopes: 'user' });
      type('b', { scopes: 'both' });
      tag('tp', { type_id: 'p' });
      tag('tu', { type_id: 'u' });
      tag('tb', { type_id: 'b' });
      const user = { scope: 'user', pass_id: 'p2', user_id: 'u1' };
      refuses(() => bind('x1', 'tp', user), /tag_type_scope/);
      refuses(() => bind('x2', 'tu'), /tag_type_scope/);
      bind('x3', 'tp');
      bind('x4', 'tu', user);
      bind('x5', 'tb');
    });
  });

  it('holds per_pass of a type on a pass, counts only active pass bindings, and leaves other types and Standard alone', () => {
    rolledBack(() => {
      type('one');
      type('two', { per_pass: 2 });
      for (const id of ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1'])
        tag(id, { type_id: id.startsWith('a') ? 'one' : id.startsWith('b') ? 'two' : null });
      bind('ba1', 'a1');
      refuses(() => bind('ba2', 'a2'), /tag_type_limit/);
      bind('ba2', 'a2', { pass_id: 'p4' });
      bind('bb1', 'b1');
      bind('bb2', 'b2');
      refuses(() => bind('bb3', 'b3'), /tag_type_limit/);
      bind('bc1', 'c1');
      sql(
        "UPDATE tag_bindings SET ended_at = 9, ended_by_type = 'staff', ended_by = 'x', end_cause = 'admin' WHERE id = 'ba1'",
      );
      bind('ba3', 'a3');
    });
  });

  it('a type with templates needs the pass template among them; none means any', () => {
    rolledBack(() => {
      type('any');
      type('only2');
      type('only1');
      sql(
        "INSERT INTO nfc_tag_type_templates (type_id, template_id) VALUES ('only2', 't2-o1'), ('only1', 't-o1')",
      );
      tag('ta', { type_id: 'any' });
      tag('t2', { type_id: 'only2' });
      tag('t1', { type_id: 'only1' });
      bind('b-any', 'ta');
      refuses(() => bind('b-2', 't2'), /tag_type_template/);
      refuses(
        () => bind('b-2u', 't2', { scope: 'user', pass_id: 'p2', user_id: 'u1' }),
        /tag_type_template/,
      );
      bind('b-1', 't1');
      sql("UPDATE passes SET template_id = 't2-o1' WHERE id = 'p4'");
      bind('b-2ok', 't2', { pass_id: 'p4' });
    });
  });

  it('keeps the 0088 limits for a Standard tag', () => {
    rolledBack(() => {
      for (const i of [1, 2, 3, 4]) {
        tag(`s${i}`);
        bind(`bs${i}`, `s${i}`);
      }
      tag('s5');
      refuses(() => bind('bs5', 's5'), /tag_binding_limit/);
    });
  });

  it('a binding never moves its expiry, and takes the four new end causes', () => {
    rolledBack(() => {
      tag('x');
      bind('bx', 'x', { expires_at: 500 });
      refuses(
        () => sql("UPDATE tag_bindings SET expires_at = 600 WHERE id = 'bx'"),
        /tag_binding_immutable/,
      );
      refuses(
        () => sql("UPDATE tag_bindings SET expires_at = NULL WHERE id = 'bx'"),
        /tag_binding_immutable/,
      );
      sql(
        "UPDATE tag_bindings SET ended_at = 9, ended_by_type = 'system', ended_by = 'tags', end_cause = 'expired' WHERE id = 'bx'",
      );
      for (const cause of ['visitor_out', 'channel_off', 'type_changed']) {
        tag(cause);
        bind(`b-${cause}`, cause);
        sql(
          `UPDATE tag_bindings SET ended_at = 9, ended_by_type = 'system', ended_by = 'x', end_cause = '${cause}' WHERE id = 'b-${cause}'`,
        );
      }
      tag('bad');
      bind('b-bad', 'bad');
      refuses(
        () =>
          sql(
            "UPDATE tag_bindings SET ended_at = 9, ended_by_type = 'system', ended_by = 'x', end_cause = 'nope' WHERE id = 'b-bad'",
          ),
        /CHECK/,
      );
    });
  });
});
