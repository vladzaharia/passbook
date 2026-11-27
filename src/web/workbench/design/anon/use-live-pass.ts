import { useDeferredValue, useEffect, useState } from 'react';
import type { InputValues } from '../../playground/model.ts';
import type { AnonBlueprint } from './blueprint.ts';

type Pass = Record<string, unknown>;

const same = (a: InputValues, b: InputValues) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  return true;
};

/**
 * The card for the values on screen. The planner loads on the first edit, so the page opens on the
 * stored card at once; a value that makes no valid pass keeps the last card that did. `failed` when
 * the planner could not load or broke: the stored card stays and the code is logged.
 */
export function useLivePass(blueprint: AnonBlueprint, values: InputValues) {
  const [shown, setShown] = useState<{ id: string; pass: Pass }>({
    id: blueprint.preview.id,
    pass: blueprint.preview.passJson,
  });
  const [failed, setFailed] = useState(false);
  const settled = useDeferredValue(values);
  useEffect(() => {
    if (same(settled, blueprint.preview.sample)) {
      setShown({ id: blueprint.preview.id, pass: blueprint.preview.passJson });
      setFailed(false);
      return;
    }
    let live = true;
    import('./live-plan.ts')
      .then(({ livePass }) => {
        const pass = live ? livePass(blueprint, settled) : null;
        if (pass) setShown({ id: blueprint.preview.id, pass });
        if (live) setFailed(false);
      })
      .catch((error: unknown) => {
        // biome-ignore lint/suspicious/noConsole: the page has no client log; this is the one stable code
        console.error('design.live_plan_failed', error);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [blueprint, settled]);
  const pass = shown.id === blueprint.preview.id ? shown.pass : blueprint.preview.passJson;
  return { pass, failed };
}
