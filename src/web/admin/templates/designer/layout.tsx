import type { ReactNode } from 'react';
import { PHONE, useMediaQuery } from '../../../lib/media.ts';
import { Button, Callout } from '../../../ui/index.ts';
import { useDesignerHost } from './host.tsx';

/**
 * Desktop (1280 and up): structure and inspector, the card, the issues. Tablet: the inspector
 * beside the card, issues under it. Phone: the card alone, read only.
 */
export function DesignerLayout({
  templateId,
  structure,
  preview,
  issues,
  readOnly = false,
  previewOnPhone = true,
}: {
  templateId: string;
  structure: ReactNode;
  preview: ReactNode;
  issues: ReactNode;
  readOnly?: boolean;
  /** A preview that cannot be read at phone width leaves only the notice and the way back. */
  previewOnPhone?: boolean;
}) {
  const phone = useMediaQuery(PHONE);
  const { Link } = useDesignerHost();
  if (phone) {
    return (
      <div className="grid gap-4">
        <Callout tone="info" title={previewOnPhone ? 'Preview only' : 'Use a larger screen'}>
          The designer needs a tablet or desktop screen.
        </Callout>
        {Link ? (
          <Button asChild variant="outline" className="justify-self-center">
            <Link place={{ to: 'template', templateId }}>Back to template</Link>
          </Button>
        ) : null}
        {previewOnPhone ? preview : null}
      </div>
    );
  }
  return (
    <div className="dz-layout" data-testid="designer-layout">
      <div className="dz-structure min-w-0" inert={readOnly} data-readonly={readOnly || undefined}>
        {structure}
      </div>
      <div className="dz-stage min-w-0">{preview}</div>
      <div className="dz-issues min-w-0">{issues}</div>
    </div>
  );
}
