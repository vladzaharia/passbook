import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { PHONE, useMediaQuery } from '../../../lib/media.ts';
import { Button, Callout } from '../../../ui/index.ts';

/**
 * Desktop (1280 and up): structure and inspector, the card, the issues. Tablet: the inspector
 * beside the card, issues under it. Phone: the card alone, read only.
 */
export function DesignerLayout({
  templateId,
  structure,
  preview,
  issues,
}: {
  templateId: string;
  structure: ReactNode;
  preview: ReactNode;
  issues: ReactNode;
}) {
  const phone = useMediaQuery(PHONE);
  if (phone) {
    return (
      <div className="grid gap-4">
        <Callout tone="info" title="Preview only">
          The designer needs a tablet or desktop screen.
        </Callout>
        {preview}
        <Button asChild variant="outline" className="justify-self-center">
          <Link to="/admin/templates/$templateId" params={{ templateId }}>
            Back to template
          </Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="dz-layout" data-testid="designer-layout">
      <div className="dz-structure min-w-0">{structure}</div>
      <div className="dz-stage min-w-0">{preview}</div>
      <div className="dz-issues min-w-0">{issues}</div>
    </div>
  );
}
