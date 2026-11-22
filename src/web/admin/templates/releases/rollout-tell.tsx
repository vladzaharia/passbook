import { useId, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { TemplateRollout } from '@/shared/contracts/template-rollout.ts';
import { errorMessage, isApiError } from '../../../lib/errors.ts';
import { formatCount } from '../../../lib/format.ts';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  FormField,
  Input,
  toast,
} from '../../../ui/index.ts';
import { useAudienceCount } from '../../messages/api.ts';
import { useTellHolders } from './rollout-api.ts';

const MAX = 120;

/** The message goes to the passes on the release now: the count is the server's, for that same audience. */
export function TellHolders({
  templateId,
  templateName,
  orgId,
  mode,
  version,
  versionName,
  tell,
  stillUpdating,
  onClose,
}: {
  templateId: string;
  templateName: string;
  orgId: string;
  mode: Mode;
  version: string;
  versionName: string;
  tell: NonNullable<TemplateRollout['tell']>;
  stillUpdating: number;
  onClose: () => void;
}) {
  const send = useTellHolders(templateId, orgId, mode, version, `${templateName} ${versionName}`);
  const audience = useAudienceCount(orgId, { templateIds: [templateId], version });
  const [text, setText] = useState(tell.text);
  const [error, setError] = useState<string>();
  const formId = useId();
  const count = audience.data?.targeted ?? 0;
  async function submit() {
    setError(undefined);
    try {
      await send.mutateAsync({ tell, text: text.trim() });
      toast.success('Message sent');
      onClose();
    } catch (cause) {
      setError(
        isApiError(cause) && cause.code === 'IDEMPOTENCY_KEY_RESERVED'
          ? 'A newer release replaced this one. Reload.'
          : errorMessage(cause),
      );
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !send.isPending && onClose()}>
      <DialogContent
        title="Tell holders"
        footer={
          <>
            <Button variant="outline" disabled={send.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              loading={send.isPending}
              disabled={!text.trim() || count === 0}
            >
              {audience.data
                ? `Tell ${formatCount(count)} ${count === 1 ? 'holder' : 'holders'}`
                : 'Tell holders'}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="grid gap-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p>
            {audience.data ? `${formatCount(count)} on ${versionName}` : 'Counting holders'}
            {audience.data && audience.data.onDevice > 0
              ? ` · ${formatCount(audience.data.onDevice)} on a phone`
              : ''}
            . Sent once, to the passes that are on it now.
          </p>
          <FormField
            label="Notify on the lock screen"
            required
            help={`${text.length}/${MAX} · Clears after a week`}
          >
            {(control) => (
              <Input
                {...control}
                value={text}
                maxLength={MAX}
                onChange={(event) => setText(event.target.value)}
              />
            )}
          </FormField>
          {stillUpdating > 0 ? (
            <Callout tone="warning">
              {formatCount(stillUpdating)} {stillUpdating === 1 ? 'pass is' : 'passes are'} still
              updating and won't get this. Wait for them to finish to tell everyone.
            </Callout>
          ) : null}
          {error ? <Callout tone="danger">{error}</Callout> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
