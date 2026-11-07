import { Buddy, type BuddyProps, type BuddyScene } from '../../ui/art/index.ts';

export type CustomerBuddyStatus =
  | 'ready'
  | 'checking'
  | 'accepted'
  | 'checkedOut'
  | 'review'
  | 'needsStaff'
  | 'undone';

type Mood = NonNullable<BuddyProps['mood']>;

const SCENE: Record<CustomerBuddyStatus, BuddyScene> = {
  ready: 'wave',
  checking: 'search',
  accepted: 'cheer',
  checkedOut: 'wave',
  review: 'inspect',
  needsStaff: 'sorry',
  undone: 'tuck',
};

const MOOD: Record<CustomerBuddyStatus, Mood> = {
  ready: 'curious',
  checking: 'curious',
  accepted: 'happy',
  checkedOut: 'happy',
  review: 'curious',
  needsStaff: 'sad',
  undone: 'flat',
};

export function CustomerBuddy({
  status,
  replay,
  className,
}: {
  status: CustomerBuddyStatus;
  replay: number;
  className?: string;
}) {
  return (
    <Buddy
      className={className}
      scene={SCENE[status]}
      mood={MOOD[status]}
      size="xl-scan"
      replay={replay}
    />
  );
}
