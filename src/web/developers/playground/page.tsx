import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';
import type { Site } from '../model/types.ts';
import { Shell } from '../pages/layout.tsx';
import { type BlueprintPreview, type BlueprintPreviews, DEFAULT_BLUEPRINT } from './model.ts';

/**
 * The playground page: a shell and one island. The island is the page; what sits inside the
 * placeholder is what a visitor sees until it loads, or without script.
 */
export function PlaygroundPage({ site, previews }: { site: Site; previews?: BlueprintPreviews }) {
  const sample =
    previews?.items.find((i) => i.id === DEFAULT_BLUEPRINT) ?? previews?.items[0] ?? null;
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
          {sample ? <StaticSample sample={sample} /> : null}
        </div>
      </div>
    </Shell>
  );
}

const text = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : '';

/** What a crawler or a reader without script sees: the blueprint's printed sample and its fields. */
function StaticSample({ sample }: { sample: BlueprintPreview }) {
  const fields = Object.entries(sample.inputs.properties ?? {}).sort(
    ([, a], [, b]) => (a['x-order'] ?? 0) - (b['x-order'] ?? 0),
  );
  return (
    <div className="pg-static">
      <img
        src={sample.paper.src}
        width={sample.paper.width}
        height={sample.paper.height}
        alt={`${sample.name} sample pass`}
      />
      <dl className="pg-fields">
        {fields.map(([name, prop]) => (
          <div key={name}>
            <dt>{prop['x-label'] ?? name}</dt>
            <dd>{text(sample.sample[name])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
