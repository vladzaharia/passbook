import { PATHS } from '../../../shared/developers.ts';
import type { Island } from '../shell/islands.ts';
import { disableZodCompiling } from './jitless.ts';
import type { BlueprintPreviews } from './model.ts';

/** The one request the anonymous page makes: a static file built at deploy. */
async function loadPreviews(): Promise<BlueprintPreviews> {
  const res = await fetch(PATHS.previews, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('The blueprint previews did not load.');
  return (await res.json()) as BlueprintPreviews;
}

/**
 * The island's entry. The page itself (boot.tsx) loads after zod is told not to compile, which it
 * decides when its schemas are built.
 */
export const mount: Island['mount'] = (el) => {
  disableZodCompiling();
  Promise.all([import('./boot.tsx'), loadPreviews()]).then(
    ([boot, data]) => boot.render(el, data),
    () =>
      import('./boot.tsx').then(
        (boot) => boot.renderFailure(el),
        () => undefined,
      ),
  );
};
