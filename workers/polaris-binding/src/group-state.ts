import { type Custom, type Registry, type Settings, withRecorded } from './registry.ts';
import { listGroupRows } from './store-groups.ts';
import type { Role } from './types.ts';

/**
 * The static registry plus what the binding recorded: role groups it created, custom groups it created and the
 * adopted groups the owner listed (once their name was first seen). A group is usable only while it is live.
 */
export async function composeRegistry(
  db: D1Database,
  base: Registry,
  settings: Settings,
): Promise<Registry> {
  const rows = await listGroupRows(db);
  // A protected placement is keyed `<role>:<name>`; a writable role group by its role.
  const roles = rows
    .filter((r) => r.kind === 'role' && r.state === 'live' && r.groupId)
    .map((r) => ({
      role: r.key.split(':')[0] as Role,
      id: r.groupId as string,
      name: r.name,
      protected: r.key.includes(':'),
    }));
  const custom: Custom[] = [];
  for (const r of rows) {
    if (!r.groupId || (r.state !== 'live' && r.state !== 'deleting')) continue;
    if (r.kind === 'custom')
      custom.push({
        key: r.key,
        id: r.groupId,
        name: r.name,
        kind: 'custom',
        deleting: r.state === 'deleting',
      });
    // An adopted group counts only while the owner still lists it, under the id they listed.
    else if (
      r.kind === 'adopted' &&
      settings.adopt.some((a) => a.key === r.key && a.id === r.groupId)
    )
      custom.push({ key: r.key, id: r.groupId, name: r.name, kind: 'adopted' });
  }
  return withRecorded(base, roles, custom);
}

/** The registry without the custom and adopted targets health found renamed or gone. */
export function withoutBlocked(registry: Registry, blocked: string[]): Registry {
  if (!blocked.length) return registry;
  return withRecorded(
    registry,
    [],
    registry.custom.filter((c) => !blocked.includes(`g:${c.key}`)),
  );
}
