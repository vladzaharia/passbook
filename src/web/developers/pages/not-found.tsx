import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { PATHS } from '../../../shared/developers.ts';
import { StateCard } from '../ui/state-card.tsx';

/** What the Worker serves, with a 404 status, for a /developers page that does not exist. */
export function NotFoundView() {
  return (
    <StateCard kind="lost" heading="h1" title={DEV_COPY.notFound.title}>
      <a className="btn outline" href={PATHS.home}>
        {GATE_COPY.notFound.home}
      </a>
      <button type="button" className="btn outline" data-search>
        {GATE_COPY.notFound.search}
      </button>
    </StateCard>
  );
}
