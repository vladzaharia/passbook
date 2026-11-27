import { useMemo } from 'react';
import { SkeletonDetail } from '../../ui/index.ts';
import { assetMap, PassPreviewPanel } from '../passes/pass-preview.tsx';
import { toHex, toRgbText } from '../templates/designer/contrast.ts';
import type { useBlueprintPreview } from './api.ts';
import { BlueprintStage } from './identity.tsx';
import type { QuickState } from './quick-fields.tsx';
import { textColors } from './quick-setup.ts';
import '../passes/passes.css';

/** The blueprint's pass as the template will be: the org's name and the chosen colour. */
function recolor(
  passJson: Record<string, unknown>,
  color: QuickState['color'],
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

/** The live pass beside (or above) the wizard: the chosen colour, and the chosen logo at once. */
export function UseStage({
  preview,
  quick,
  orgName,
}: {
  preview: ReturnType<typeof useBlueprintPreview>;
  quick: QuickState;
  orgName: string | undefined;
}) {
  const data = preview.data;
  const logoUrl = quick.logo?.url;
  // A chosen logo shows at once: its local URL stands in for the logo files.
  const assetUrls = useMemo(
    () =>
      data && logoUrl
        ? {
            ...assetMap(data.assetBaseUrl, data.assetNames),
            'logo.png': logoUrl,
            'logo@2x.png': logoUrl,
            'logo@3x.png': logoUrl,
          }
        : undefined,
    [data, logoUrl],
  );
  if (!data) return <SkeletonDetail label="Loading preview" />;
  return (
    <BlueprintStage passJson={data.passJson}>
      <PassPreviewPanel
        passJson={recolor(data.passJson, quick.color, orgName)}
        assetBaseUrl={data.assetBaseUrl}
        assetNames={data.assetNames}
        assetUrls={assetUrls}
        mint={`${quick.color ? toHex(quick.color) : ''}:${quick.logo?.name ?? ''}`}
        enter={false}
      />
    </BlueprintStage>
  );
}
