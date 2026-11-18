import { TAG_COPY } from '@/shared/copy/tags.ts';
import type { ConfirmCopy } from '@/web/lib/confirms.ts';
import { fill } from './words.ts';

/** Words for the tag confirms, in the shape lib/confirms.ts uses (spread into ConfirmDialog). */

export function removeTagConfirm(
  tag: string,
  who: { person: false } | { person: true; name: string; passes?: number | undefined },
): ConfirmCopy {
  if (!who.person) {
    return {
      title: `Remove ${tag} from this pass?`,
      confirmLabel: TAG_COPY.removePerson.confirm,
      description: 'It stops working with this pass.',
      typed: false,
    };
  }
  return {
    title: fill(TAG_COPY.removePerson.title, { tag, name: who.name }),
    confirmLabel: TAG_COPY.removePerson.confirm,
    description:
      who.passes === undefined
        ? `It stops working with all of ${who.name}'s passes.`
        : fill(TAG_COPY.removePerson.body, { n: who.passes }),
    typed: false,
  };
}

export const lostTagConfirm = (tag: string): ConfirmCopy => ({
  title: fill(TAG_COPY.lostConfirm.title, { tag }),
  confirmLabel: TAG_COPY.menu.reportLost,
  description: TAG_COPY.lostConfirm.body,
  typed: false,
});

export const restoreTagConfirm = (tag: string, target: string): ConfirmCopy => ({
  title: fill(TAG_COPY.restoreConfirm.title, { tag }),
  confirmLabel: TAG_COPY.menu.restore,
  description: fill(TAG_COPY.restoreConfirm.body, { target }),
  typed: false,
});
