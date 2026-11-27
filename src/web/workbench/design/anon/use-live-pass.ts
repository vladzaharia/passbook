import { useEffect, useState } from 'react';
import type { InputValues } from '../../playground/model.ts';
import type { AnonBlueprint } from './blueprint.ts';

type Pass = Record<string, unknown>;

/**
 * The card for the values on screen. The planner loads on first use, so the page opens on the
 * stored card at once; a value that makes no valid pass keeps the last card that did.
 */
export function useLivePass(blueprint: AnonBlueprint, values: InputValues): Pass {
  const [shown, setShown] = useState<{ id: string; pass: Pass }>({
    id: blueprint.preview.id,
    pass: blueprint.preview.passJson,
  });
  useEffect(() => {
    let live = true;
    import('./live-plan.ts').then(
      ({ livePass }) => {
        const pass = live ? livePass(blueprint, values) : null;
        if (pass) setShown({ id: blueprint.preview.id, pass });
      },
      // The planner did not load: the stored card stays.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [blueprint, values]);
  return shown.id === blueprint.preview.id ? shown.pass : blueprint.preview.passJson;
}
