import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';
import type { Site } from '../model/types.ts';
import { Shell } from '../pages/layout.tsx';

/**
 * The playground page: a shell and one island. The island is the page; what sits inside the
 * placeholder is what a visitor sees until it loads, or without script.
 */
export function PlaygroundPage({ site }: { site: Site }) {
  return (
    <Shell site={site} active="playground" bare>
      <div className="pg" data-island="playground">
        <div className="pg-fallback">
          <h1 className="h2">{DEV_COPY.slots.playground.title}</h1>
          <p>
            <a className="btn outline" href={PATHS.reference}>
              {DEV_COPY.home.reference}
            </a>
          </p>
        </div>
      </div>
    </Shell>
  );
}
