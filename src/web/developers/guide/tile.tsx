import { stepOf } from './group.ts';
import { guideIcon } from './icons.ts';

/** The square beside a guide: its icon on the tone of its step. The title names the guide. */
export function GuideTile({ id }: { id: string }) {
  const Icon = guideIcon(id);
  return (
    <span className={`gtile ${stepOf(id).tone}`}>
      <Icon className="lucide" aria-hidden="true" />
    </span>
  );
}
