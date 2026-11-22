import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';
import { StateCard } from '../ui/state-card.tsx';

/** What the Worker serves, with a 404 status, for a /developers page that does not exist. */
export function NotFoundView() {
  return (
    <StateCard kind="error" heading="h1" title={DEV_COPY.notFound.title}>
      <a className="btn" href={PATHS.home}>
        {DEV_COPY.notFound.home}
      </a>
      <a className="btn outline" href={PATHS.reference}>
        {DEV_COPY.reference.title}
      </a>
    </StateCard>
  );
}
