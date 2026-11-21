import { Link } from '@tanstack/react-router';
import { Eye, Rocket, Smartphone } from 'lucide-react';
import { Badge, Button } from '../../../ui/index.ts';
import type { NextKind } from './next-action.ts';

/** The state's primary action: what the server's `next` says to do. */
export function ReleasePrimary({
  kind,
  label,
  templateId,
  orgId,
  onTry,
  onRelease,
  onReview,
  pending = false,
}: {
  kind: Exclude<NextKind, 'pass'>;
  label: string;
  templateId: string;
  orgId: string | undefined;
  onTry: () => void;
  onRelease: () => void;
  onReview: () => void;
  pending?: boolean;
}) {
  if (kind === 'wait') return <Badge tone="warning">{label}</Badge>;
  if (kind === 'design')
    return (
      <Button asChild className="whitespace-nowrap" iconStart={<Smartphone aria-hidden />}>
        <Link to="/admin/templates/$templateId/design" params={{ templateId }} search={{ orgId }}>
          {label}
        </Link>
      </Button>
    );
  const [icon, onClick] =
    kind === 'try'
      ? [<Smartphone key="i" aria-hidden />, onTry]
      : kind === 'review'
        ? [<Eye key="i" aria-hidden />, onReview]
        : [<Rocket key="i" aria-hidden />, onRelease];
  return (
    <Button className="whitespace-nowrap" iconStart={icon} loading={pending} onClick={onClick}>
      {label}
    </Button>
  );
}
