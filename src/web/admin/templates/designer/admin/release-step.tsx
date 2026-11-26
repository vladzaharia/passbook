import { isPrimary, nextAction } from '../../releases/next-action.ts';
import { ReleasePrimary } from '../../releases/release-primary.tsx';
import { useReleaseControls } from '../../releases/use-release-controls.tsx';
import { type Template, vOf } from '../../versions.ts';
import { type ReleaseStep, useDesignerHost } from '../host.tsx';

/** Admin's next step beside Undo (Try, Release or Review) and the dialogs it opens, as before. */
export function useAdminReleaseStep(
  templateId: string,
  template: Template | undefined,
): ReleaseStep {
  const { orgId, allows } = useDesignerHost();
  const draft = template?.release?.draft?.version;
  const action = template?.release
    ? nextAction(template.release.next, draft ? vOf(template, draft) : '')
    : null;
  const next = action && isPrimary(action) && action.kind !== 'design' ? action : null;
  const open = template?.release?.review;
  const controls = useReleaseControls(
    templateId,
    orgId,
    (hash) => (template && hash ? vOf(template, hash) : ''),
    {
      canPublish: allows.publishLive,
      requestedBy: open?.state === 'open' ? open.by : null,
    },
  );
  return {
    action: next ? (
      <ReleasePrimary
        kind={next.kind}
        label={next.label}
        templateId={templateId}
        orgId={orgId}
        onTry={() => void controls.tryVersion(draft ?? '')}
        onRelease={() => controls.release(draft ?? '')}
        onReview={() => controls.startReview(draft ?? '')}
      />
    ) : null,
    dialog: controls.dialog,
  };
}
