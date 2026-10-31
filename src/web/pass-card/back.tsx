import type { FieldView, LayoutView, PassView } from '../../shared/pass-view/index.ts';
import { Rich } from './parts.tsx';

function Group({ title, fields }: { title?: string; fields: FieldView[] }) {
  if (!fields.length) return null;
  return (
    <section className="pc-group">
      {title ? <h3 className="pc-group-title">{title}</h3> : null}
      <ul className="pc-list">
        {fields.map((f) => (
          <li key={f.key} className="pc-item">
            {f.label ? <span className="pc-label">{f.label}</span> : null}
            <span className="pc-value">
              <Rich field={f} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Back({ view, layout }: { view: PassView; layout: LayoutView }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
    // biome-ignore lint/a11y/useSemanticElements: a landmark per card is noise on list pages
    <div className="pc-back-body" role="region" aria-label="Pass details" tabIndex={0}>
      <div className="pc-back-head">
        <h2 className="pc-title">{view.organizationName}</h2>
        {view.description && view.description !== view.organizationName ? (
          <p className="pc-sub">{view.description}</p>
        ) : null}
      </div>
      {layout.actions.length ? (
        <ul className="pc-actions">
          {layout.actions.map((a) => (
            <li key={a.identifier}>
              {a.href ? (
                <a
                  className="pc-action"
                  href={a.href}
                  {...(a.href.startsWith('https:') ? { target: '_blank' } : {})}
                  rel="noopener noreferrer nofollow"
                >
                  {a.label}
                </a>
              ) : (
                <span className="pc-action" data-disabled="">
                  {a.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <Group title="Additional info" fields={layout.additionalInfo} />
      <Group fields={layout.back} />
      <Group title="More" fields={layout.overflow} />
    </div>
  );
}
