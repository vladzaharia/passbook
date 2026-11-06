import { useState } from 'react';
import type { z } from 'zod';
import type { ScannerPairingSchema } from '@/shared/contracts/scanners.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { getMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, Dialog, DialogContent, Form, useFormErrors } from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { useOrgList } from '../../orgs/queries.ts';
import { PairingFace } from '../pairing-face.tsx';
import { useCreateScanner } from '../scanner-api.ts';
import { createBody, draftErrors, EMPTY_DRAFT, type ScannerDraft } from './scanner-draft.ts';
import { ScannerFields } from './scanner-fields.tsx';

type Pairing = z.infer<typeof ScannerPairingSchema>;

/** Server problem codes that point at one field. */
const FIELD_OF: Record<string, [string, string]> = {
  SCANNER_NAME_TAKEN: ['name', 'A scanner here already has this name.'],
  EVENT_ENDED: ['eventId', 'This event has ended.'],
};

export interface NewScannerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Duplicate: the same settings under a new name; the pairing is not copied. */
  initial?: ScannerDraft | undefined;
}

/**
 * New scanner: the settings, then (a browser scanner) the pairing face in the same dialog. The
 * mode is the console's current mode, as for passes, so there is no mode field.
 */
export function NewScannerDialog({ open, onOpenChange, initial }: NewScannerDialogProps) {
  const { orgId: scoped } = useOrgScope();
  const orgs = useOrgList();
  const create = useCreateScanner();
  const [draft, setDraft] = useState<ScannerDraft>({ ...EMPTY_DRAFT, ...initial });
  const [server, setServer] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [made, setMade] = useState<{ id: string; name: string; pairing: Pairing | null }>();
  const orgId = draft.orgId || scoped || '';
  const needsOrg = !scoped;
  const check = useFormErrors(draftErrors({ ...draft, orgId }, needsOrg));
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };

  const patch = (next: Partial<ScannerDraft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setServer({});
  };
  function close() {
    onOpenChange(false);
    setDraft({ ...EMPTY_DRAFT, ...initial });
    setServer({});
    setFormError(undefined);
    setMade(undefined);
    check.reset();
  }

  async function submit() {
    setFormError(undefined);
    try {
      const created = await create.mutateAsync(createBody({ ...draft, orgId }));
      setMade({ id: created.id, name: created.name, pairing: created.pairing });
    } catch (cause) {
      const coded = isApiError(cause) ? FIELD_OF[cause.code] : undefined;
      if (coded) setServer({ [coded[0]]: coded[1] });
      else if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServer(cause.fields);
      else setFormError(errorMessage(cause));
    }
  }

  const title = (text: string) => (
    <span className="inline-flex flex-wrap items-center gap-2">
      {text}
      <ModePill mode={getMode()} />
    </span>
  );

  if (made) {
    return (
      <Dialog open={open} onOpenChange={() => undefined}>
        <DialogContent
          size="lg"
          closeButton={false}
          title={title(`Pair ${made.name}`)}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          {made.pairing ? (
            <PairingFace
              scanner={{ id: made.id, name: made.name, mode: getMode() }}
              pairing={made.pairing}
              onClose={close}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      dirty={draft.name.trim() !== ''}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        size="md"
        title={title('New scanner')}
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="new-scanner" loading={create.isPending}>
              Create and pair
            </Button>
          </>
        }
      >
        <Form id="new-scanner" {...check.form} onValid={() => void submit()}>
          <ScannerFields
            autoFocus
            draft={{ ...draft, orgId }}
            onChange={patch}
            errors={errors}
            orgs={needsOrg ? orgs.data?.items : undefined}
          />
          {formError ? <p className="mt-4 text-sm text-danger">{formError}</p> : null}
        </Form>
      </DialogContent>
    </Dialog>
  );
}
