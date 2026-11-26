import { DevelopersSection } from './developers/developers-section.tsx';

/** Where the Developers section mounts on the Members page (DI-5). */
export function MembersDevelopersSlot({ orgId }: { orgId: string }) {
  return <DevelopersSection orgId={orgId} />;
}
