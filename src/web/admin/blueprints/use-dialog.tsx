import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { BrandPartName } from '@/passkit/template/brand.ts';
import type { UseBlueprintRequest } from '@/shared/contracts/index.ts';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { errorMessage } from '../../lib/errors.ts';
import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { markMinted } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { Button, Dialog, DialogContent, FormField, Input, Select } from '../../ui/index.ts';
import { usePassSetup } from '../brand/api.ts';
import { brandingUrl } from '../orgs/queries.ts';
import { markCreated } from '../passes/created.tsx';
import { parseColor } from '../templates/designer/contrast.ts';
import { assetsPayload } from '../templates/designer/images.ts';
import { useBlueprintVersion, useLoadBlueprintVersion, useUseBlueprint } from './api.ts';
import { writeOrgBrand } from './org-brand-write.ts';
import { QuickFields, useQuickFields } from './quick-fields.tsx';
import { brandDoc, choicesOf, docOfVersion } from './quick-setup.ts';

type Blueprint = Pick<TemplateSummaryDto, 'id' | 'name' | 'activeVersion'>;

/**
 * Use blueprint: an organization, a name, and quick setup (a logo and its colour). Create template
 * makes a tracked, branded template on any screen; Open designer starts a draft on a larger one.
 */
export function UseBlueprintDialog({
  blueprint,
  open,
  onOpenChange,
}: {
  blueprint: Blueprint;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const phone = useMediaQuery(PHONE);
  const navigate = useNavigate();
  const scope = useOrgScope();
  // Only organizations where the person authors templates can receive one.
  const orgs = useMemo(
    () => scope.memberships.filter((m) => m.capabilities.includes('templates:author')),
    [scope.memberships],
  );
  const fallback = orgs.find((m) => m.orgId === scope.orgId)?.orgId ?? orgs[0]?.orgId;
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [name, setName] = useState(blueprint.name);
  const [error, setError] = useState<{ org?: string; name?: string; form?: string }>({});
  const create = useUseBlueprint(blueprint.id);
  const load = useLoadBlueprintVersion();
  const quick = useQuickFields();
  const version = useBlueprintVersion(blueprint.id, blueprint.activeVersion);
  const choices = useMemo(
    () => (version.data ? choicesOf(docOfVersion(version.data)) : {}),
    [version.data],
  );
  const orgId = chosen ?? fallback;
  const setup = usePassSetup(orgId ?? '', Boolean(orgId) && open);
  const orgBrand = setup.data?.brand;
  const colors = orgBrand?.passColors.value;
  const canWrite = Boolean(
    scope.memberships.find((m) => m.orgId === orgId)?.capabilities.includes('org:manage'),
  );
  const orgSetsLogo = orgBrand?.logo.source === 'org';
  const orgSetsColors = orgBrand?.passColors.source === 'org';
  // With no org brand yet the logo and colour become the organization's; otherwise (or without the
  // right to write it) the template keeps its own, and says so in its manifest.
  const logoToOrg = quick.logo !== null && !orgSetsLogo && canWrite;
  const colorToOrg = quick.color !== undefined && !orgSetsColors && canWrite;
  const own: BrandPartName[] = [
    ...(quick.logo && !logoToOrg ? (['logo'] as const) : []),
    ...(quick.color && !colorToOrg ? (['colors'] as const) : []),
  ];
  const templateTouched =
    own.length > 0 || quick.goal !== undefined || quick.currency !== undefined;

  function check(): { orgId: string; name: string } | null {
    const next = name.trim();
    const problems = {
      ...(orgId ? {} : { org: 'Choose an organization.' }),
      ...(next ? {} : { name: 'Enter a name.' }),
    };
    setError(problems);
    return orgId && next ? { orgId, name: next } : null;
  }

  function openDesigner() {
    const input = check();
    if (!input) return;
    onOpenChange(false);
    void navigate({
      to: '/admin/o/$orgId/templates/new',
      params: { orgId: input.orgId },
      search: { blueprint: blueprint.id, name: input.name },
    });
  }

  /** The request: an exact copy, or the draft with the logo and colour put in. */
  async function request(input: { orgId: string; name: string }): Promise<UseBlueprintRequest> {
    if (!templateTouched || !blueprint.activeVersion) return input;
    const doc = brandDoc(docOfVersion(await load(blueprint.id, blueprint.activeVersion)), {
      name: input.name,
      color: quick.color && !colorToOrg ? quick.color : undefined,
      logo: quick.logo && !logoToOrg ? quick.logo.asset : undefined,
      goal: quick.goal,
      currency: quick.currency,
      own,
    });
    return {
      ...input,
      version: {
        passJson: doc.passJson,
        manifest: doc.manifest as never,
        assets: assetsPayload(doc.assets),
      },
    };
  }

  async function submit() {
    const input = check();
    if (!input) return;
    try {
      if (logoToOrg || colorToOrg)
        await writeOrgBrand(input.orgId, {
          logo: logoToOrg ? quick.logo?.asset.upload : undefined,
          color: colorToOrg ? quick.color : undefined,
        });
      const made = await create.mutateAsync(await request(input));
      markMinted(`template:${made.id}`);
      markCreated(`template:${made.id}`, 'fromBlueprint');
      onOpenChange(false);
      void navigate({
        to: '/admin/o/$orgId/templates/$templateId',
        params: { orgId: input.orgId, templateId: made.id },
      });
    } catch (cause) {
      setError({ form: errorMessage(cause) });
    }
  }

  return (
    <Dialog
      open={open}
      dirty={name !== blueprint.name || chosen !== undefined || quick.touched}
      onOpenChange={onOpenChange}
    >
      <DialogContent
        title="Use blueprint"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {phone ? null : (
              <Button variant="outline" disabled={quick.touched} onClick={openDesigner}>
                Open designer
              </Button>
            )}
            <Button loading={create.isPending} onClick={() => void submit()}>
              Create template
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label="Organization" required error={error.org}>
            {(c) => (
              <Select
                {...c}
                value={orgId}
                placeholder="Choose an organization"
                onValueChange={(v) => {
                  setChosen(v);
                  setError({});
                }}
                options={orgs.map((m) => ({ value: m.orgId, label: m.orgName }))}
              />
            )}
          </FormField>
          <FormField label="Name" required error={error.name ?? error.form}>
            {(c) => (
              <Input
                {...c}
                data-autofocus
                value={name}
                maxLength={120}
                onChange={(e) => {
                  setName(e.target.value);
                  setError({});
                }}
              />
            )}
          </FormField>
          <QuickFields
            state={quick}
            choices={choices}
            org={{
              logoUrl:
                orgSetsLogo && orgBrand?.logo.value && orgId
                  ? brandingUrl(orgId, 'logo', orgBrand.logo.value.sha)
                  : null,
              colors:
                orgSetsColors && colors?.background
                  ? (parseColor(colors.background) ?? null)
                  : null,
              canWrite,
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
