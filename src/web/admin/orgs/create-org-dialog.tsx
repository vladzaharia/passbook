import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { Button, Dialog, DialogContent, FormField, Input } from '@/web/ui/index.ts';
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

/** Creates the org and stays on the list, where the new row lights up; the toast opens it. */
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();

  function close() {
    onOpenChange(false);
    setName('');
    setSlug('');
    setSlugEdited(false);
    setErrors({});
    setFormError(undefined);
  }

  async function submit() {
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = 'Required.';
    if (!SLUG.test(slug)) found.slug = 'Use 2 to 64 lowercase letters, digits or hyphens.';
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length > 0) return;
    try {
      const org = await create.mutateAsync({ name: name.trim(), slug });
      close();
      toast.success('Organization created', {
        duration: 6000,
        action: {
          label: 'Open',
          onClick: () => void navigate({ to: '/admin/orgs/$orgId', params: { orgId: org.id } }),
        },
      });
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setErrors(cause.fields);
      setFormError(errorMessage(cause));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
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
        <form
          id="new-org"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
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
                }}
              />
            )}
          </FormField>
          {formError ? <p className="text-sm text-danger">{formError}</p> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
