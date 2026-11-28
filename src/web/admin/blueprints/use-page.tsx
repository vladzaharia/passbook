import { useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router';
import { PenTool } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { markMinted } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  detailError,
  Form,
  FormField,
  Input,
  PageHeader,
  SkeletonDetail,
  SwitchRow,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
  useWizard,
  Wizard,
  WizardReview,
} from '../../ui/index.ts';
import { usePassSetup } from '../brand/api.ts';
import { brandingUrl } from '../orgs/queries.ts';
import { parseColor, toHex } from '../templates/designer/contrast.ts';
import { useBlueprint, useBlueprintPreview, useBlueprintVersion, useUseBlueprint } from './api.ts';
import { saveOrgBrand, unbranded } from './org-brand.ts';
import { QuickFields, useQuickFields } from './quick-fields.tsx';
import { choicesOf, docOfVersion } from './quick-setup.ts';
import { useBlueprintRequest } from './use-request.ts';
import { UseStage } from './use-stage.tsx';

const crumbs = (orgId: string, name?: string) => [
  { label: 'Blueprints', to: `/admin/o/${orgId}/blueprints` },
  { label: name ?? 'Blueprint' },
];

const STEPS = [
  { id: 'name', title: 'Name', heading: 'Name the template' },
  { id: 'look', title: 'Look', heading: 'Logo and colour' },
  { id: 'review', title: 'Review', heading: 'Check and create' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

/**
 * Make it yours, as the page wizard: Name, Look (a logo and a colour) and Review, with the live
 * pass beside the steps. Create makes the org's template and opens it; Use for all passes also
 * makes the colour and logo the organization's pass brand.
 */
export function UseBlueprintPage({ blueprintId, orgId }: { blueprintId: string; orgId: string }) {
  const query = useBlueprint(blueprintId);
  if (query.isError)
    return detailError(query, {
      entity: 'blueprint',
      to: '/admin/blueprints',
      header: <PageHeader title="Make it yours" breadcrumbs={crumbs(orgId)} />,
    });
  if (!query.data)
    return (
      <>
        <PageHeader title="Make it yours" breadcrumbs={crumbs(orgId)} />
        <SkeletonDetail label="Loading blueprint" />
      </>
    );
  return <Loaded blueprint={query.data} orgId={orgId} />;
}

function Loaded({
  blueprint: b,
  orgId,
}: {
  blueprint: NonNullable<ReturnType<typeof useBlueprint>['data']>;
  orgId: string;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(b.name);
  const [forAll, setForAll] = useState<boolean | undefined>(undefined);
  const quick = useQuickFields();
  const create = useUseBlueprint(b.id);
  const request = useBlueprintRequest();
  const preview = useBlueprintPreview(b.id);
  const version = useBlueprintVersion(b.id, b.activeVersion);
  const setup = usePassSetup(orgId);
  const choices = useMemo(
    () => (version.data ? choicesOf(docOfVersion(version.data)) : {}),
    [version.data],
  );
  // Only people who can save the pass setup see the switch; it starts on for an unbranded org.
  const canBrand = setup.data !== undefined;
  const brandAll = forAll ?? (setup.data ? unbranded(setup.data.brand) : false);
  const orgBrand = setup.data?.brand;
  const orgSetsLogo = orgBrand?.logo.source === 'org';
  const orgSetsColors = orgBrand?.passColors.source === 'org';
  const bg = orgBrand?.passColors.value?.background;
  // What the organization already sets stays the organization's; the rest goes to it only on "Use for all passes".
  // Whether the switch would change anything: nothing reaches the brand without a logo or colour of its own.
  const reaches =
    canBrand &&
    ((!orgSetsLogo && quick.logo !== null) || (!orgSetsColors && quick.color !== undefined));
  const toOrg = {
    logo: canBrand && brandAll && !orgSetsLogo && quick.logo !== null,
    colors: canBrand && brandAll && !orgSetsColors && quick.color !== undefined,
  };
  const orgName = useOrgScope().membership?.orgName;
  const phone = useMediaQuery(PHONE);
  const coarse = useMediaQuery('(pointer: coarse)');
  const wide = useMediaQuery('(min-width: 1024px)');
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const guard = useUnsavedChangesGuard(name !== b.name || quick.touched);

  const goal = choices.goal ? (quick.goal ?? choices.goal.value) : undefined;
  const currency = choices.currency ? (quick.currency ?? choices.currency.value) : undefined;
  const looks = [
    quick.logo ? 'Logo' : '',
    quick.color ? 'Colour' : '',
    quick.goal !== undefined ? 'Stamps' : '',
    quick.currency !== undefined ? 'Currency' : '',
  ].filter(Boolean);
  const w = useWizard<StepId>({
    steps: STEPS.map((s) => ({
      ...s,
      ...(s.id === 'name' ? { summary: name.trim() || undefined } : {}),
      ...(s.id === 'look' ? { summary: looks.join(', ') || 'Blueprint look' } : {}),
    })),
    errors: { name: name.trim() ? {} : { name: 'Enter a name.' } },
    hints: { name: 'Name the template.' },
    fieldStep: { name: 'name' },
    onFinish: async () => {
      const made = await create.mutateAsync(
        await request(b, { orgId, name: name.trim() }, quick, toOrg),
      );
      markMinted(`template:${made.id}`);
      if (toOrg.logo || toOrg.colors) {
        try {
          await saveOrgBrand(orgId, {
            color: toOrg.colors ? quick.color : undefined,
            logo: toOrg.logo ? quick.logo?.file : undefined,
          });
        } catch (cause) {
          toast.error(cause, 'The template is made, but the brand was not saved');
        }
      }
      void navigate({
        to: '/admin/o/$orgId/templates/$templateId',
        params: { orgId, templateId: made.id },
        ignoreBlocker: true,
      });
    },
  });
  const designerNote =
    quick.touched && !phone ? "Your choices here won't carry over to the designer." : undefined;
  const stage = <UseStage preview={preview} quick={quick} orgName={orgName} />;
  const cancel = () =>
    canGoBack ? router.history.back() : void navigate({ to: '/admin/o/$orgId', params: { orgId } });

  return (
    <>
      <PageHeader title="Make it yours" breadcrumbs={crumbs(orgId, b.name)} />
      <Wizard
        {...w.frame}
        onCancel={cancel}
        nextLabel={
          w.primary === 'finish' ? 'Create template' : w.primary === 'review' ? 'Review' : 'Next'
        }
        busy={w.finishing || create.isPending}
        aside={stage}
        asideLabel="Preview"
        asideQuiet
        barMenu={
          phone
            ? undefined
            : [
                {
                  label: 'Open designer',
                  icon: PenTool,
                  onSelect: () =>
                    name.trim()
                      ? void navigate({
                          to: '/admin/o/$orgId/templates/new',
                          params: { orgId },
                          search: { blueprint: b.id, name: name.trim() },
                          ignoreBlocker: true,
                        })
                      : w.id === 'name'
                        ? w.next()
                        : w.go('name'),
                },
              ]
        }
      >
        <Form {...w.form} className="flex min-w-0 flex-col gap-5">
          {w.id === 'name' ? (
            <FormField label="Name" required error={w.errors.name}>
              {(c) => (
                <Input
                  {...c}
                  {...(coarse ? {} : { 'data-autofocus': true })}
                  value={name}
                  maxLength={120}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </FormField>
          ) : null}
          {w.id === 'look' ? (
            <>
              {wide ? null : stage}
              <QuickFields
                state={quick}
                choices={choices}
                org={{
                  logoUrl:
                    orgSetsLogo && orgBrand?.logo.value
                      ? brandingUrl(orgId, 'logo', orgBrand.logo.value.sha)
                      : null,
                  colors: orgSetsColors && bg ? (parseColor(bg) ?? null) : null,
                  // The switch below is how a choice reaches the organization.
                  canWrite: false,
                }}
              />
              {canBrand ? (
                <SwitchRow
                  label="Use for all passes"
                  help="Also sets this logo and colour as your pass brand."
                  checked={brandAll}
                  onCheckedChange={setForAll}
                />
              ) : null}
              {designerNote ? <p className="text-xs text-fg-muted">{designerNote}</p> : null}
            </>
          ) : null}
          {w.id === 'review' ? (
            <WizardReview
              level={3}
              note={designerNote}
              onEdit={w.go}
              preview={wide ? undefined : stage}
              sections={[
                { id: 'name', title: 'Name', items: [{ label: 'Name', value: name.trim() }] },
                {
                  id: 'look',
                  title: 'Look',
                  items: [
                    { label: 'Logo', value: quick.logo?.name ?? 'From the blueprint' },
                    {
                      label: 'Colour',
                      value: quick.color ? toHex(quick.color) : 'From the blueprint',
                    },
                    ...(goal !== undefined
                      ? [{ label: 'Stamps for a reward', value: String(goal) }]
                      : []),
                    ...(currency !== undefined ? [{ label: 'Currency', value: currency }] : []),
                    ...(reaches
                      ? [{ label: 'Use for all passes', value: brandAll ? 'Yes' : 'No' }]
                      : []),
                  ],
                },
              ]}
            />
          ) : null}
        </Form>
      </Wizard>
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
