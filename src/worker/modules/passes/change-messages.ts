import { FIELD_GROUPS } from '../../../passkit/schema/constants.ts';
import { PASS_STYLES, type PassJson } from '../../../passkit/types.ts';

type Field = { key?: unknown; value?: unknown; changeMessage?: unknown };

function fieldsOf(pass: PassJson): Map<string, Field> {
  const out = new Map<string, Field>();
  for (const style of PASS_STYLES) {
    const dict = (pass as Record<string, unknown>)[style];
    if (!dict || typeof dict !== 'object') continue;
    for (const group of FIELD_GROUPS) {
      const list = (dict as Record<string, unknown>)[group];
      if (!Array.isArray(list)) continue;
      for (const f of list as Field[])
        if (f && typeof f === 'object' && typeof f.key === 'string') out.set(f.key, f);
    }
  }
  return out;
}

/**
 * An editor's save. Without `notify` every changeMessage goes; with it, a field keeps (or gets
 * "%@") its message only when its value differs from the previous version. Returns true when the
 * pass changed. Wallet only shows a message for a changed value, so syncs keep the template's.
 */
export function applyChangeMessages(
  pass: PassJson,
  previous: PassJson | null,
  notify: boolean,
): boolean {
  const before = previous ? fieldsOf(previous) : new Map<string, Field>();
  let changed = false;
  for (const [key, field] of fieldsOf(pass)) {
    const moved = notify && JSON.stringify(before.get(key)?.value) !== JSON.stringify(field.value);
    if (moved) {
      if (typeof field.changeMessage !== 'string') {
        field.changeMessage = '%@';
        changed = true;
      }
    } else if (field.changeMessage !== undefined) {
      delete field.changeMessage;
      changed = true;
    }
  }
  return changed;
}
