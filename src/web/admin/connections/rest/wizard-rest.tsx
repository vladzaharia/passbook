import { cleanValues } from '../../passes/schema-form/index.ts';
import { nestValues } from '../config-schema.ts';
import type { ConfigDraft } from '../wizard-steps.tsx';
import { RestSlot } from './rest-slot.tsx';

/** The wizard's REST step: the explorer over the draft. Only secrets the chosen auth uses are sent. */
export function WizardRest({
  orgId,
  draft,
  onChange,
  hiddenSecrets,
  showErrors,
  onSample,
}: {
  orgId: string;
  draft: ConfigDraft;
  onChange: (next: (d: ConfigDraft) => ConfigDraft) => void;
  hiddenSecrets: ReadonlySet<string>;
  showErrors: boolean;
  onSample?: ((fields: { pointer: string; preview: string }[]) => void) | undefined;
}) {
  return (
    <RestSlot
      bare
      orgId={orgId}
      value={draft.config}
      onChange={(patch) => onChange((d) => ({ ...d, config: { ...d.config, ...patch } }))}
      toConfig={(v) => nestValues(cleanValues(v))}
      secrets={Object.fromEntries(
        Object.entries(cleanValues(draft.secrets))
          .filter(([k]) => !hiddenSecrets.has(k))
          .map(([k, v]) => [k, String(v)]),
      )}
      showErrors={showErrors}
      onSample={onSample}
    />
  );
}
