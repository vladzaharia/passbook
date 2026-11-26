import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader } from '../../../ui/index.ts';

/** The explorer's frame: a card on the Config tab, a headed section inside the wizard's card. */
export function RestShell({
  bare,
  action,
  children,
}: {
  bare: boolean | undefined;
  action: ReactNode;
  children: ReactNode;
}) {
  if (!bare)
    return (
      <Card>
        <CardHeader title="Response" actions={action} />
        <CardBody className="flex min-w-0 flex-col gap-5">{children}</CardBody>
      </Card>
    );
  return (
    <section
      aria-label="Response"
      className="flex min-w-0 flex-col gap-5 border-t border-border pt-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-fg-strong">Response</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
