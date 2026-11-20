import { type OfflineMode, settingsOfflineVerdict } from '@/shared/scan-offline.ts';
import { SegmentedControl } from '@/web/ui/index.ts';
import { settingsOf } from '../scanners/scanner-draft.ts';
import type { SessionDraft } from './draft.ts';

const HELP: Record<OfflineMode, string> = {
  stop: 'Scans wait for a connection. Nothing is let in unchecked.',
  decide:
    'Staff let people in by eye. Each entry is checked when the door is back online, and a bad one shows as a conflict.',
  list: 'The door checks a list of valid passes held on the device. No names are stored. The scanner must be open before the connection drops, and NFC tags still need a connection.',
};

/** O8: one setting for what the door does with no connection. */
export function SessionOfflineFields({
  draft,
  set,
}: {
  draft: SessionDraft;
  set: (patch: Partial<SessionDraft>) => void;
}) {
  const verdict = settingsOfflineVerdict(
    settingsOf(draft),
    draft.accepts === 'event' ? 0 : (draft.zoneIds?.length ?? 0),
  );
  return (
    <section className="mt-6 grid gap-3 border-t border-border pt-6" data-testid="session-offline">
      <h3 className="text-sm font-semibold text-fg-strong">When offline</h3>
      <SegmentedControl
        label="When offline"
        value={draft.whenOffline}
        onValueChange={(whenOffline) => set({ whenOffline })}
        options={[
          { value: 'stop', label: 'Stop' },
          { value: 'decide', label: 'Staff decide' },
          { value: 'list', label: 'Use the offline list', disabled: !verdict.ok },
        ]}
        block
      />
      <p className="text-xs text-fg-muted">{HELP[draft.whenOffline]}</p>
      {verdict.ok ? null : (
        <p className="text-xs text-fg-muted" role="note">
          {verdict.message}
        </p>
      )}
    </section>
  );
}
