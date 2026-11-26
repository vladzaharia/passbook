import { Link, useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { errorMessage } from '../../lib/errors.ts';
import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { markMinted } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  Button,
  Card,
  CardBody,
  detailError,
  FormField,
  Input,
  PageHeader,
  SkeletonDetail,
  SwitchRow,
  toast,
} from '../../ui/index.ts';
import { usePassSetup } from '../brand/api.ts';
import { brandingUrl } from '../orgs/queries.ts';
import { assetMap, PassPreviewPanel } from '../passes/pass-preview.tsx';
import { parseColor, toHex, toRgbText } from '../templates/designer/contrast.ts';
import { useBlueprint, useBlueprintPreview, useBlueprintVersion, useUseBlueprint } from './api.ts';
import { BlueprintStage } from './identity.tsx';
import { saveOrgBrand, unbranded } from './org-brand.ts';
import { QuickFields, useQuickFields } from './quick-fields.tsx';
import { choicesOf, docOfVersion, textColors } from './quick-setup.ts';
import { useBlueprintRequest } from './use-request.ts';
import '../passes/passes.css';

const crumbs = (orgId: string, name?: string) => [
  { label: 'Blueprints', to: `/admin/o/${orgId}/blueprints` },
  { label: name ?? 'Blueprint' },
];

/** The blueprint's pass as the template will be: the org's name and the chosen colour. */
function recolor(
  passJson: Record<string, unknown>,
  color: Parameters<typeof textColors>[0] | undefined,
  orgName: string | undefined,
) {
  const named = orgName && typeof passJson.logoText === 'string' ? { logoText: orgName } : {};
  if (!color) return { ...passJson, ...named };
  const { foreground, label } = textColors(color);
  return {
    ...passJson,
    ...named,
    backgroundColor: toRgbText(color),
    foregroundColor: toRgbText(foreground),
    labelColor: toRgbText(label),
  };
}

/**
 * Make it yours: a name, a logo and a colour beside the live pass (the logo included). Create makes the org's template
 * and opens it; Use for all passes also makes the colour and logo the organization's pass brand.
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
  const [error, setError] = useState<string>();
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
  const toOrg = {
    logo: canBrand && brandAll && !orgSetsLogo && quick.logo !== null,
    colors: canBrand && brandAll && !orgSetsColors && quick.color !== undefined,
  };
  const orgName = useOrgScope().membership?.orgName;
  const passJson = preview.data ? recolor(preview.data.passJson, quick.color, orgName) : undefined;
  // A chosen logo shows at once: its local URL stands in for the logo files.
  const logoUrl = quick.logo?.url;
  const assetUrls = useMemo(
    () =>
      preview.data && logoUrl
        ? {
            ...assetMap(preview.data.assetBaseUrl, preview.data.assetNames),
            'logo.png': logoUrl,
            'logo@2x.png': logoUrl,
            'logo@3x.png': logoUrl,
          }
        : undefined,
    [preview.data, logoUrl],
  );
  const phone = useMediaQuery(PHONE);
  const coarse = useMediaQuery('(pointer: coarse)');
  const router = useRouter();
  const canGoBack = useCanGoBack();

  async function submit() {
    const next = name.trim();
    if (!next) return setError('Enter a name.');
    setError(undefined);
    try {
      const made = await create.mutateAsync(await request(b, { orgId, name: next }, quick, toOrg));
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
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <>
      <PageHeader title="Make it yours" breadcrumbs={crumbs(orgId, b.name)} />
      <form
        className="grid items-start gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Card>
          <CardBody className="flex flex-col gap-5">
            <FormField label="Name" required error={error}>
              {(c) => (
                <Input
                  {...c}
                  {...(coarse ? {} : { 'data-autofocus': true })}
                  value={name}
                  maxLength={120}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(undefined);
                  }}
                />
              )}
            </FormField>
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
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              {phone ? null : (
                <Button
                  variant="outline"
                  onClick={() => {
                    const next = name.trim();
                    if (!next) return setError('Enter a name.');
                    void navigate({
                      to: '/admin/o/$orgId/templates/new',
                      params: { orgId },
                      search: { blueprint: b.id, name: next },
                    });
                  }}
                >
                  Open designer
                </Button>
              )}
              {canGoBack ? (
                <Button variant="outline" onClick={() => router.history.back()}>
                  Cancel
                </Button>
              ) : (
                <Button asChild variant="outline">
                  <Link to="/admin/o/$orgId" params={{ orgId }}>
                    Cancel
                  </Link>
                </Button>
              )}
              <Button type="submit" loading={create.isPending}>
                Create
              </Button>
            </div>
            {quick.touched && !phone ? (
              <p className="text-right text-xs text-fg-muted">
                Your choices here won't carry over to the designer.
              </p>
            ) : null}
          </CardBody>
        </Card>
        <div className="order-first min-w-0 lg:order-none lg:sticky lg:top-4">
          {preview.data && passJson ? (
            <BlueprintStage passJson={preview.data.passJson}>
              <PassPreviewPanel
                passJson={passJson}
                assetBaseUrl={preview.data.assetBaseUrl}
                assetNames={preview.data.assetNames}
                assetUrls={assetUrls}
                mint={`${quick.color ? toHex(quick.color) : ''}:${quick.logo?.name ?? ''}`}
                enter={false}
              />
            </BlueprintStage>
          ) : (
            <SkeletonDetail label="Loading preview" />
          )}
        </div>
      </form>
    </>
  );
}
