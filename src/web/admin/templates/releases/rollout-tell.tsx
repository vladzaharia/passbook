import { useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { TemplateRollout } from '@/shared/contracts/template-rollout.ts';
import { isApiError, UserMessageError } from '../../../lib/errors.ts';
import { formatCount } from '../../../lib/format.ts';
import { Callout, FormDialog, FormField, Input, toast, useFormErrors } from '../../../ui/index.ts';
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
  const check = useFormErrors(text.trim() ? {} : { text: 'Write a message.' });
  const count = audience.data?.targeted ?? 0;
  async function submit() {
    if (audience.data && count === 0) throw new UserMessageError('No passes are on this release.');
    try {
      await send.mutateAsync({ tell, text: text.trim() });
    } catch (cause) {
      throw isApiError(cause) && cause.code === 'IDEMPOTENCY_KEY_RESERVED'
        ? new UserMessageError('A newer release replaced this one. Reload.')
        : cause;
    }
    toast.success('Message sent');
    onClose();
  }
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Tell holders"
      dirty={text !== tell.text}
      check={check}
      onSubmit={submit}
      busy={send.isPending}
      submitLabel={
        audience.data
          ? `Tell ${formatCount(count)} ${count === 1 ? 'holder' : 'holders'}`
          : 'Tell holders'
      }
      notice={
        stillUpdating > 0 ? (
          <Callout tone="warning">
            {formatCount(stillUpdating)} {stillUpdating === 1 ? 'pass is' : 'passes are'} still
            updating and won't get this. Wait for them to finish to tell everyone.
          </Callout>
        ) : null
      }
    >
      {({ errors, clear }) => (
        <>
          <p className="text-sm">
            {audience.data ? `${formatCount(count)} on ${versionName}` : 'Counting holders'}
            {audience.data && audience.data.onDevice > 0
              ? ` · ${formatCount(audience.data.onDevice)} on a phone`
              : ''}
            . Sent once, to the passes that are on it now.
          </p>
          <FormField
            label="Notify on the lock screen"
            required
            error={check.errors.text ?? errors.text}
            help={`${text.length}/${MAX} · Clears after a week`}
          >
            {(control) => (
              <Input
                {...control}
                data-autofocus
                value={text}
                maxLength={MAX}
                onChange={(event) => {
                  setText(event.target.value);
                  clear('text');
                }}
              />
            )}
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
