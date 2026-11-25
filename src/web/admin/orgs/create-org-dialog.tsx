import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import type { CreateOrgSchema } from '@/shared/contracts/orgs.ts';
import { PLAN_COPY } from '@/shared/copy/plans.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  SwitchRow,
  useFormErrors,
} from '@/web/ui/index.ts';
import { markCreated } from '../passes/created.tsx';
import { PlanPicker } from './features/plan-picker.tsx';
import { usePresets } from './features/preset-queries.ts';
import { useCreateOrg } from './queries.ts';

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

type PlanId = NonNullable<z.input<typeof CreateOrgSchema>['preset']>;

/** What a new org starts on when nothing is picked; the server's own default. */
const DEFAULT_PLAN = 'standard';

/** The plans as cards, once they load. A failed read leaves the field out; the create still sends the default plan. */
function PlanField({ value, onChange }: { value: string; onChange: (preset: string) => void }) {
  const presets = usePresets();
  const plans = (presets.data?.presets ?? []).filter((p) => p.preset !== 'developer');
  if (plans.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-fg">{PLAN_COPY.title}</span>
      <PlanPicker plans={plans} current={null} picked={value} onPick={onChange} />
    </div>
  );
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

function validate(name: string, slug: string): Record<string, string> {
  const found: Record<string, string> = {};
  if (!name.trim()) found.name = 'Required.';
  if (!SLUG.test(slug)) found.slug = 'Use 2 to 64 lowercase letters, digits or hyphens.';
  return found;
}

/**
 * Creates the org and opens it, where a Created callout and the checklist carry the next steps.
 * The dialog has no history entry of its own, so Back from the new org returns to the list.
 */
export function CreateOrgDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useCreateOrg();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [addMe, setAddMe] = useState(true);
  const [preset, setPreset] = useState(DEFAULT_PLAN);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const check = useFormErrors(validate(name, slug));
  const errors = { ...serverErrors, ...check.errors };

  function close() {
    onOpenChange(false);
    setName('');
    setSlug('');
    setSlugEdited(false);
    setAddMe(true);
    setPreset(DEFAULT_PLAN);
    check.reset();
    setServerErrors({});
    setFormError(undefined);
  }

  async function submit() {
    setFormError(undefined);
    try {
      const org = await create.mutateAsync({
        name: name.trim(),
        slug,
        addMe,
        preset: preset as PlanId,
      });
      close();
      markCreated(`org:${org.id}`);
      void navigate({ to: '/admin/orgs/$orgId', params: { orgId: org.id } });
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServerErrors(cause.fields);
      setFormError(errorMessage(cause));
    }
  }
  const clearServer = (key: string) => setServerErrors(({ [key]: _gone, ...rest }) => rest);

  return (
    <Dialog
      open={open}
      dirty={name.trim() !== '' || slug !== ''}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        size="lg"
        title="New organization"
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="new-org" loading={create.isPending}>
              Create
            </Button>
          </>
        }
      >
        <Form
          id="new-org"
          className="flex flex-col gap-4"
          {...check.form}
          onValid={() => void submit()}
        >
          <FormField label="Name" required error={errors.name}>
            {(p) => (
              <Input
                {...p}
                data-autofocus
                autoComplete="off"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearServer('name');
                  if (!slugEdited) setSlug(slugify(e.target.value));
                }}
              />
            )}
          </FormField>
          <FormField
            label="Slug"
            required
            error={errors.slug}
            help="Used in links and typed to delete."
          >
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={slug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value);
                  clearServer('slug');
                }}
              />
            )}
          </FormField>
          <PlanField value={preset} onChange={setPreset} />
          <SwitchRow label="Add me as admin" checked={addMe} onCheckedChange={setAddMe} />
          {formError ? <p className="text-sm text-danger">{formError}</p> : null}
        </Form>
      </DialogContent>
    </Dialog>
  );
}
