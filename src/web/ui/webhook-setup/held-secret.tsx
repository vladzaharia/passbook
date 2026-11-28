import { Button } from '../button.tsx';
import { Callout } from '../callout.tsx';
import { CheckboxField } from '../checkbox.tsx';
import { CopyField } from '../secret-reveal.tsx';
import { RotateSecretForm, type RotateSecretState } from './rotate-secret-form.tsx';

/**
 * A secret PassBook made. Held (just made): shown once, masked, with "I saved the secret" for the
 * step's Next to wait on. Not held (resumed later): it cannot be shown again, so a new one is made
 * through the rotation form.
 */
export function HeldSecret({
  held,
  saved,
  onSaved,
  rotate,
  onRotated,
  choices,
}: {
  held: string | undefined;
  saved: boolean;
  onSaved: (saved: boolean) => void;
  rotate: RotateSecretState;
  onRotated: () => void;
  choices?: Parameters<typeof RotateSecretForm>[0]['choices'];
}) {
  if (held)
    return (
      <div className="flex max-w-xl min-w-0 flex-col gap-4">
        <Callout tone="warning">Copy the secret now. It is not shown again.</Callout>
        <CopyField label="Signing secret" value={held} copyLabel="Copy signing secret" />
        <CheckboxField
          label="I saved the secret"
          checked={saved}
          onCheckedChange={(v) => onSaved(v === true)}
          className="w-fit"
        />
      </div>
    );
  return (
    <div className="flex max-w-md min-w-0 flex-col gap-4">
      <RotateSecretForm state={rotate} onDone={onRotated} choices={choices} />
      {rotate.secret ? null : (
        <div>
          <Button type="submit" form={rotate.formId} loading={rotate.busy}>
            New secret
          </Button>
        </div>
      )}
    </div>
  );
}
