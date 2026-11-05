import { useState } from 'react';
import type { ScannerDto } from '@/shared/contracts/scanners.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Form,
  KeyValue,
  SaveBar,
  type SaveResult,
  toast,
  useFormErrors,
} from '@/web/ui/index.ts';
import { RelTime } from '../../passes/detail/rel-time.tsx';
import { useUpdateScanner } from '../scanner-api.ts';
import { acceptsOf, draftErrors, draftOf, type ScannerDraft, settingsOf } from './scanner-draft.ts';
import { ScannerFields } from './scanner-fields.tsx';

/** The dialog's fields, saved through the SaveBar. */
export function SettingsCard({ scanner }: { scanner: ScannerDto }) {
  const saved = draftOf(scanner);
  const [edits, setEdits] = useState<Partial<ScannerDraft>>({});
  const [server, setServer] = useState<Record<string, string>>({});
  const update = useUpdateScanner(scanner.id);
  const draft = { ...saved, ...edits };
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const check = useFormErrors(draftErrors(draft, false));
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };
  const readOnly = scanner.status === 'revoked';

  async function save(): Promise<SaveResult> {
    try {
      await update.mutateAsync({
        name: draft.name.trim(),
        accepts: acceptsOf(draft),
        settings: settingsOf(draft),
      });
      setEdits({});
      check.reset();
      toast.success('Saved');
      return 'saved';
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) {
        setServer(cause.fields);
        return 'refused';
      }
      toast.error(cause, 'Could not save');
      return 'failed';
    }
  }

  return (
    <Card>
      <CardHeader title="Settings" />
      <CardBody>
        <Form id="scanner-settings" {...check.form} onValid={save}>
          <fieldset disabled={readOnly} className="min-w-0">
            <ScannerFields
              draft={draft}
              onChange={(patch) => {
                setEdits((e) => ({ ...e, ...patch }));
                setServer({});
              }}
              errors={errors}
            />
          </fieldset>
        </Form>
      </CardBody>
      {readOnly ? null : (
        <SaveBar
          dirty={dirty}
          saving={update.isPending}
          paused={update.isPaused}
          formId="scanner-settings"
          onDiscard={() => {
            setEdits({});
            setServer({});
            check.reset();
          }}
        />
      )}
    </Card>
  );
}

/** What the device is and who is on it. */
export function DeviceCard({ scanner, now }: { scanner: ScannerDto; now: number }) {
  return (
    <Card>
      <CardHeader title="Device" />
      <CardBody>
        <KeyValue
          items={[
            { label: 'Device', value: scanner.kind === 'terminal' ? 'Till' : scanner.pairedLabel },
            {
              label: 'Paired',
              value: scanner.pairedAt === null ? null : formatDateTime(scanner.pairedAt),
            },
            {
              label: 'Last seen',
              value:
                scanner.lastSeenAt === null ? (
                  'Never'
                ) : (
                  <RelTime at={scanner.lastSeenAt} now={now} />
                ),
            },
            { label: 'Signed in', value: scanner.staff?.name ?? null },
          ]}
        />
      </CardBody>
    </Card>
  );
}

export function DangerCard({ onRevoke }: { onRevoke: () => void }) {
  return (
    <Card>
      <CardHeader title="Danger" />
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-fg-muted">Signs the device out. Its scans stay.</p>
        <Button variant="outline" className="self-start text-danger" onClick={onRevoke}>
          Revoke
        </Button>
      </CardBody>
    </Card>
  );
}
