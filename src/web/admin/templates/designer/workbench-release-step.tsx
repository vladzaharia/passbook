import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button, toast } from '../../../ui/index.ts';
import { templateKeys } from '../api.ts';
import type { Template } from '../versions.ts';
import { type ReleaseStep, useDesignerHost } from './host.tsx';

/**
 * The Workbench's release step: the newest saved version into Test, through `host.release`. One
 * idempotency key per attempt, so a second click while it runs is the same release.
 */
export function useWorkbenchReleaseStep(
  templateId: string,
  template: Template | undefined,
): ReleaseStep | null {
  const { release } = useDesignerHost();
  const client = useQueryClient();
  const key = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const draft = template?.release?.draft?.version;
  const inTest = template?.release?.test?.version;
  if (!release || !draft || draft === inTest) return null;
  async function run(version: string) {
    if (!release) return;
    setBusy(true);
    try {
      await release(templateId, version, key.current);
      key.current = crypto.randomUUID();
      toast.success('Released in Test');
      await client.invalidateQueries({ queryKey: templateKeys.all });
    } catch (cause) {
      toast.error(cause, 'Could not release');
    } finally {
      setBusy(false);
    }
  }
  return {
    action: (
      <Button
        className="whitespace-nowrap"
        iconStart={<FlaskConical aria-hidden />}
        loading={busy}
        onClick={() => void run(draft)}
      >
        Release in Test
      </Button>
    ),
    dialog: null,
  };
}
