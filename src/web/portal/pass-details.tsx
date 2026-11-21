import { useId } from 'react';
import type { FieldView, PassView } from '../../shared/pass-view/index.ts';
import { BackSections, hasBack } from '../pass-card/back.tsx';
import { Card, CardBody } from '../ui/card-base.tsx';
import { fieldRows } from './pass-fields.ts';

/**
 * Everything the card's face does not show, as the card's own back draws it (pass-card/back.tsx:
 * featured actions, upcoming events, additional info, the back fields with their links, the front
 * fields past the face's limits), then Expires. One card for the portal and /p, the page's only
 * details; none when there is nothing to add. No visible title and no status: the card stamps a
 * voided or expired pass and the page's notice says it.
 */
export function PassDetails({
  passJson,
  view,
  locale,
  now,
  timeZone,
}: {
  /** The issued pass.json, for Expires; the bundle page has only the view and goes without. */
  passJson?: Record<string, unknown>;
  view: PassView;
  locale: string;
  /** The caller's clock: the server's request clock, the portal's own. */
  now: Date;
  /** The visitor's zone; unknown on the server without one, then Expires names its zone. */
  timeZone?: string;
}) {
  const titleId = useId();
  const layout = view.layouts[view.target];
  // fieldRows adds Expires only when no field on either side already says it.
  const expires = passJson
    ? fieldRows(passJson, { locale, now, ...(timeZone ? { timeZone } : {}) }, 'back').find(
        (r) => r.id === 'expirationDate',
      )
    : undefined;
  const extra: FieldView[] = expires
    ? [
        {
          key: expires.id,
          label: expires.label,
          text: expires.value,
          segments: [{ text: expires.value }],
          align: 'natural',
        },
      ]
    : [];
  if (!hasBack(view, layout) && !extra.length) return null;
  return (
    <section aria-labelledby={titleId}>
      {/* The card says what it is; the heading keeps the page's outline (h1, h2, h3). */}
      <h2 id={titleId} className="sr-only">
        Details
      </h2>
      <Card>
        <CardBody className="pc-flat flex flex-col gap-4">
          <BackSections view={view} layout={layout} extra={extra} />
        </CardBody>
      </Card>
    </section>
  );
}
