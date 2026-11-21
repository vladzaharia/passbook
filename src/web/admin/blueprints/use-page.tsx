import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { errorMessage } from '../../lib/errors.ts';
import { markMinted } from '../../lib/motion.ts';
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
import { PassPreviewPanel } from '../passes/pass-preview.tsx';
import { toRgbText } from '../templates/designer/contrast.ts';
import { useBlueprint, useBlueprintPreview, useBlueprintVersion, useUseBlueprint } from './api.ts';
import { BlueprintStage } from './identity.tsx';
import { saveOrgBrand, unbranded } from './org-brand.ts';
import { QuickFields, useQuickFields } from './quick-fields.tsx';
import { choicesOf, docOfVersion, textColors } from './quick-setup.ts';
import { useBlueprintRequest } from './use-request.ts';
import '../passes/passes.css';

const crumbs = (name?: string) => [
  { label: 'Blueprints', to: '/admin/blueprints' },
  { label: name ?? 'Blueprint' },
];

/** The blueprint's pass in the chosen colour; the logo shows once the template exists. */
function recolor(
  passJson: Record<string, unknown>,
  color: Parameters<typeof textColors>[0] | undefined,
) {
  if (!color) return passJson;
  const { foreground, label } = textColors(color);
  return {
    ...passJson,
    backgroundColor: toRgbText(color),
    foregroundColor: toRgbText(foreground),
    labelColor: toRgbText(label),
  };
}

/**
 * Make it yours: a name, a logo and a colour beside the live pass. Create makes the org's template
 * and opens it; Use for all passes also makes the colour and logo the organization's pass brand.
 */
export function UseBlueprintPage({ blueprintId, orgId }: { blueprintId: string; orgId: string }) {
  const query = useBlueprint(blueprintId);
  if (query.isError)
    return detailError(query, {
      entity: 'blueprint',
      to: '/admin/blueprints',
      header: <PageHeader title="Make it yours" breadcrumbs={crumbs()} />,
    });
  if (!query.data)
    return (
      <>
        <PageHeader title="Make it yours" breadcrumbs={crumbs()} />
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
  const passJson = preview.data ? recolor(preview.data.passJson, quick.color) : undefined;

  async function submit() {
    const next = name.trim();
    if (!next) return setError('Enter a name.');
    setError(undefined);
    try {
      const made = await create.mutateAsync(await request(b, { orgId, name: next }, quick));
      markMinted(`template:${made.id}`);
      if (canBrand && brandAll && (quick.color || quick.logo)) {
        try {
          await saveOrgBrand(orgId, { color: quick.color, logo: quick.logo?.file });
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
      <PageHeader title="Make it yours" breadcrumbs={crumbs(b.name)} />
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
                  data-autofocus
                  value={name}
                  maxLength={120}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(undefined);
                  }}
                />
              )}
            </FormField>
            <QuickFields state={quick} choices={choices} />
            {canBrand ? (
              <SwitchRow
                label="Use for all passes"
                checked={brandAll}
                onCheckedChange={setForAll}
              />
            ) : null}
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button asChild variant="outline">
                <Link
                  to="/admin/o/$orgId/blueprints/$blueprintId"
                  params={{ orgId, blueprintId: b.id }}
                >
                  Cancel
                </Link>
              </Button>
              <Button type="submit" loading={create.isPending}>
                Create
              </Button>
            </div>
          </CardBody>
        </Card>
        <div className="min-w-0 lg:sticky lg:top-4">
          {preview.data && passJson ? (
            <BlueprintStage passJson={preview.data.passJson}>
              <PassPreviewPanel
                passJson={passJson}
                assetBaseUrl={preview.data.assetBaseUrl}
                assetNames={preview.data.assetNames}
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
