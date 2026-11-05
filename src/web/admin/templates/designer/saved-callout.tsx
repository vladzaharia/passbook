import { Link } from '@tanstack/react-router';
import { Button, Callout } from '../../../ui/index.ts';
import type { Saved } from './save-flow.ts';

/** After Save version: passes keep the active version until it is activated. */
export function SavedCallout({
  templateId,
  saved,
  onActivate,
}: {
  templateId: string;
  saved: Saved;
  onActivate: () => void;
}) {
  return (
    <Callout
      className="mb-4"
      tone="success"
      actions={
        saved.activated ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/templates/$templateId" params={{ templateId }}>
              Open template
            </Link>
          </Button>
        ) : (
          <Button size="sm" onClick={onActivate}>
            Activate
          </Button>
        )
      }
    >
      {saved.activated
        ? 'Version saved and active.'
        : 'Version saved. Passes keep the active version until you activate it.'}
    </Callout>
  );
}
