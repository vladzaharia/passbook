import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import { Head } from './more.tsx';

/** What the Worker serves, with a 404 status, for a /developers page that does not exist. */
export function NotFoundView() {
  const links = [
    [PATHS.quickstart, QS_COPY.nav],
    [PATHS.reference, DEV_COPY.reference.title],
    [PATHS.guides, DEV_COPY.slots.guides.title],
    [PATHS.home, 'Home'],
  ] as const;
  return (
    <>
      <Head title={DEV_COPY.notFound.title} line={DEV_COPY.notFound.line} />
      <div className="wrap-row g2 mt8">
        {links.map(([href, label]) => (
          <a key={href} className="btn outline" href={href}>
            {label}
          </a>
        ))}
      </div>
    </>
  );
}
