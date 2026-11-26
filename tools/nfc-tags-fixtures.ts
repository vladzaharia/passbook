// Shared by the 0128 schema tests: a node:sqlite database migrated up to a point, with tags, bindings and
// enrolments of every shape 0088-0097 allow. Foreign keys are enforced; triggers are off while seeding.
import type { DatabaseSync } from 'node:sqlite';
import {
  migratedBefore,
  migrationFile,
  read,
  seedParents,
  withoutTriggers,
} from './wallet-instances-fixtures.ts';

export const OLD_CAUSES = [
  'admin',
  'staff',
  'undo',
  'lost',
  'replaced',
  'moved',
  'holder_changed',
  'pass_deleted',
  'no_passes',
  'offboard',
  'pass_ended',
  'tag_retired',
] as const;

/** A 64-digit reference whose first four digits are `n` in hex. */
export const ref = (n: number) => `${n.toString(16).padStart(4, '0')}${'a'.repeat(60)}`;
export const hint = (n: number) => ref(n).slice(0, 4).toUpperCase();

type Value = string | number | null;
/** INSERT one row from an object; a value is bound, never spliced. */
export function row(db: DatabaseSync, table: string, values: Record<string, Value>) {
  const cols = Object.keys(values);
  db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...Object.values(values));
}

export const addPass = (db: DatabaseSync, id: string, org: string, owner: string | null = null) =>
  row(db, 'passes', {
    id,
    org_id: org,
    identity_id: `sid-${org}`,
    serial: `s-${id}`,
    template_id: `t-${org}`,
    template_version: 'v1',
    auth_token: 'a',
    download_token: `d-${id}`,
    web_service_url: 'https://x.test',
    object_key: `k-${id}`,
    modified_at: 1,
    created_at: 1,
    owner_user_id: owner,
  });

const tag = (db: DatabaseSync, n: number, org: string, extra: Record<string, Value> = {}) =>
  row(db, 'nfc_tags', {
    id: `tg${n}`,
    org_id: org,
    mode: 'live',
    tag_ref: ref(n),
    kind: 'uid',
    hint: hint(n),
    created_at: 1,
    ...extra,
  });

const bind = (db: DatabaseSync, id: string, tagId: string, extra: Record<string, Value>) =>
  row(db, 'tag_bindings', {
    id,
    tag_id: tagId,
    scope: 'pass',
    pass_id: 'p1',
    source: 'admin',
    bound_at: 7,
    bound_by_type: 'user',
    bound_by: 'x',
    holder_generation: 0,
    ...extra,
  });

const enrollment = (db: DatabaseSync, id: string, extra: Record<string, Value>) =>
  row(db, 'tag_enrollments', {
    id,
    org_id: 'o1',
    mode: 'live',
    scanner_id: 's1',
    requested_by: 'adm',
    scope: 'pass',
    created_at: 10,
    expires_at: 20,
    holder_generation: 0,
    ...extra,
  });

/** Two orgs; o1 has passes p1 to p4 (p2 owned by u1), a scanner s1, and tags of every shape. */
export function seedTags(db: DatabaseSync) {
  withoutTriggers(db, () => {
    seedParents(db, 'o1', 'p1');
    seedParents(db, 'o2', 'po2');
    row(db, 'users', { id: 'u1', primary_email: 'u1@x.test', created_at: 1 });
    addPass(db, 'p2', 'o1', 'u1');
    addPass(db, 'p3', 'o1');
    addPass(db, 'p4', 'o1');
    row(db, 'scanners', {
      id: 's1',
      org_id: 'o1',
      mode: 'live',
      kind: 'device',
      name: 'Door',
      settings: '{}',
      time_zone: 'America/Los_Angeles',
      created_at: 1,
      updated_at: 1,
    });
    tag(db, 1, 'o1', { last_seen_at: 9, label: 'Wristband' });
    bind(db, 'b1', 'tg1', {
      source: 'scanner',
      bound_by_type: 'staff',
      scanner_id: 's1',
      idempotency_key: 'k1',
      request_hash: 'h1',
      holder_owner: 'someone',
    });
    tag(db, 2, 'o1');
    bind(db, 'b2', 'tg2', { scope: 'user', pass_id: 'p2', user_id: 'u1', source: 'remote' });
    tag(db, 3, 'o1', { lost_at: 9, lost_by: 'x' });
    tag(db, 4, 'o1', { status: 'retired', status_at: 4 });
    tag(db, 5, 'o2');
    tag(db, 6, 'o1');
    OLD_CAUSES.forEach((cause, i) => {
      tag(db, 20 + i, 'o1');
      bind(db, `be${i}`, `tg${20 + i}`, {
        pass_id: 'p3',
        ended_at: 8,
        ended_by_type: 'staff',
        ended_by: 'x',
        end_cause: cause,
        cleared_lost_at: i === 3 ? 3 : null,
        cleared_lost_by: i === 3 ? 'x' : null,
      });
    });
    enrollment(db, 'e1', { pass_id: 'p1', state: 'done', ended_at: 15, binding_id: 'b1' });
    enrollment(db, 'e2', { pass_id: 'p3', state: 'pending' });
    enrollment(db, 'e3', { pass_id: 'p4', state: 'cancelled', ended_at: 12 });
  });
}

/** Everything before 0128, with the seed in it. */
export function seededBefore0128(): DatabaseSync {
  const db = migratedBefore('0128');
  seedTags(db);
  return db;
}

/** 0128 applied over the seed, plus a second template in each org, and the helpers the trigger tests share. */
export function tagWorld() {
  const db = seededBefore0128();
  db.exec(read(migrationFile('0128')));
  for (const org of ['o1', 'o2'])
    row(db, 'templates', {
      id: `t2-${org}`,
      org_id: org,
      slug: 't2',
      name: 'T2',
      origin: 'uploaded',
      created_at: 1,
      updated_at: 1,
    });
  row(db, 'template_versions', {
    template_id: 't2-o1',
    version: 'v1',
    manifest: '{}',
    pass_json: '{}',
    created_at: 1,
  });
  let n = 100;
  type Over = Record<string, string | number | null>;
  /** Run `fn` and roll everything it wrote back. */
  const rolledBack = (fn: () => void) => {
    db.exec('SAVEPOINT t');
    try {
      fn();
    } finally {
      db.exec('ROLLBACK TO t');
      db.exec('RELEASE t');
    }
  };
  return {
    db,
    rolledBack,
    sql: (text: string) => db.exec(text),
    // As 0129 will: drop the read-only trigger, enable, and (here) leave it off for the rollback.
    enableSun: () => {
      db.exec('DROP TRIGGER nfc_tag_systems_fixed');
      db.exec("UPDATE nfc_tag_systems SET enabled = 1 WHERE id = 'sun'");
    },
    type: (id: string, over: Over = {}) =>
      row(db, 'nfc_tag_types', {
        id,
        org_id: 'o1',
        name: id,
        system: 'uid',
        use: 'member',
        created_at: 1,
        created_by: 'adm',
        updated_at: 1,
        ...over,
      }),
    tag: (id: string, over: Over = {}) => {
      n += 1;
      row(db, 'nfc_tags', {
        id,
        org_id: 'o1',
        mode: 'live',
        tag_ref: ref(n),
        system: 'uid',
        hint: hint(n),
        created_at: 1,
        ...over,
      });
    },
    bind: (id: string, tagId: string, over: Over = {}) =>
      row(db, 'tag_bindings', {
        id,
        tag_id: tagId,
        scope: 'pass',
        pass_id: 'p3',
        source: 'admin',
        bound_at: 7,
        bound_by_type: 'user',
        bound_by: 'x',
        holder_generation: 0,
        ...over,
      }),
  };
}
