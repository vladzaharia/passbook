import { CircleDashed, CircleSlash, Link2, ShieldX } from 'lucide-react';
import type { Tag } from '@/shared/contracts/nfc-tags.ts';
import { Badge } from '@/web/ui/index.ts';

const STATE: Record<Tag['state'], { label: string; Icon: typeof Link2; tone?: 'success' }> = {
  assigned: { label: 'Assigned', Icon: Link2, tone: 'success' },
  spare: { label: 'Spare', Icon: CircleDashed },
  lent: { label: 'Lent', Icon: Link2 },
  lost: { label: 'Lost', Icon: ShieldX },
  retired: { label: 'Retired', Icon: CircleSlash },
};

export const TAG_STATE_FILTERS = [
  { value: 'any', label: 'any' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'spare', label: 'Spare' },
  { value: 'lost', label: 'Lost' },
  { value: 'retired', label: 'Retired' },
] as const;

/** Icon plus word, never colour alone. */
export function StateBadge({ state }: { state: Tag['state'] }) {
  const { label, Icon, tone } = STATE[state];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}
