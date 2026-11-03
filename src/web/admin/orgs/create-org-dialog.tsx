import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { Button, Dialog, DialogContent, Form, FormField, Input } from '@/web/ui/index.ts';
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

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

function validate(name: string, slug: string): Record<string, string> {
  const found: Record<string, string> = {};
  if (!name.trim()) found.name = 'Required.';
  if (!SLUG.test(slug)) found.slug = 'Use 2 to 64 lowercase letters, digits or hyphens.';
  return found;
}

/** Creates the org and opens it, where the checklist shows the next steps. */
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
  // Once shown, errors follow the values: a fix clears its message on the same keystroke.
  const [shown, setShown] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const local = validate(name, slug);
  const errors = { ...serverErrors, ...(shown ? local : {}) };

  function close() {
    onOpenChange(false);
    setName('');
    setSlug('');
    setSlugEdited(false);
    setShown(false);
    setServerErrors({});
    setFormError(undefined);
  }

  async function submit() {
    setFormError(undefined);
    try {
      const org = await create.mutateAsync({ name: name.trim(), slug });
      close();
      toast.success('Organization created');
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
        size="md"
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
          invalid={Object.keys(local).length > 0}
          onInvalid={() => setShown(true)}
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
          {formError ? <p className="text-sm text-danger">{formError}</p> : null}
        </Form>
      </DialogContent>
    </Dialog>
  );
}
