import { FormField, Input } from '../../../../ui/index.ts';
import type { Editor } from './scan-outline-ui.tsx';
import { safePreviewText } from './scan-preview-policy.ts';
import { ScanTextField } from './scan-text-fields.tsx';
import { useRejection } from './use-rejection.ts';

export { Notes };

function Notes({ editor: e, refusedOnly = false }: { editor: Editor; refusedOnly?: boolean }) {
  const rejection = useRejection(true);
  return (
    <div className="grid gap-4">
      {!refusedOnly ? (
        <ScanTextField
          label="Staff note"
          value={e.display.notes?.staff}
          manifest={e.bindings.manifest}
          passJson={e.bindings.passJson}
          optional
          mergeKey="scan:notes:staff"
          onChange={(staff, merge) =>
            e.onChange({ ...e.display, notes: { ...e.display.notes, staff } }, merge)
          }
        />
      ) : null}
      <FormField
        label="Refused note"
        error={rejection.error}
        help={
          e.display.notes?.refused && !safePreviewText(e.display.notes.refused)
            ? 'This note cannot be displayed safely. Enter a replacement.'
            : 'Plain text only, up to 100 characters. Refused screens show no other template content.'
        }
      >
        {(control) => (
          <Input
            {...control}
            maxLength={100}
            value={
              e.display.notes?.refused && safePreviewText(e.display.notes.refused)
                ? e.display.notes.refused
                : ''
            }
            onBlur={rejection.clear}
            onChange={(event) => {
              const refused = event.target.value;
              if (!rejection.accept(refused)) return;
              e.onChange(
                { ...e.display, notes: { ...e.display.notes, refused: refused || undefined } },
                'scan:notes:refused',
              );
            }}
          />
        )}
      </FormField>
      <p className="text-xs text-fg-muted">Event notes are set per event, not in this template.</p>
    </div>
  );
}
