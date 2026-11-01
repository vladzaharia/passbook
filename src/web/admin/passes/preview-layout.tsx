import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader } from '../../ui/index.ts';

/** Preview beside the tabs at >=1280, stacked above them below. */
export function PreviewLayout({
  previewActions,
  preview,
  children,
}: {
  previewActions?: ReactNode;
  preview: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
      <Card className="max-w-sm min-w-0 xl:self-start">
        <CardHeader title="Preview" actions={previewActions} />
        <CardBody>{preview}</CardBody>
      </Card>
      {children}
    </div>
  );
}
