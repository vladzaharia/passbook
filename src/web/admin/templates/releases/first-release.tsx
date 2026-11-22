import { Skeleton } from '../../../ui/index.ts';
import { PassPreview } from '../../passes/pass-preview.tsx';
import { useTemplatePreview } from '../api.ts';

/** The front of the version's pass, with "First release": what the release and review dialogs show instead of a diff. */
export function FirstRelease({
  templateId,
  orgId,
  version,
  enabled,
}: {
  templateId: string;
  orgId: string;
  version: string;
  enabled: boolean;
}) {
  const preview = useTemplatePreview(enabled ? templateId : '', orgId, version);
  if (!enabled) return null;
  return (
    <div className="grid justify-items-center gap-2">
      {preview.data ? (
        <div className="w-44">
          <PassPreview
            passJson={preview.data.passJson}
            assetBaseUrl={preview.data.assetBaseUrl}
            assetNames={preview.data.assetNames}
            still
          />
        </div>
      ) : (
        <Skeleton className="h-56 w-44 rounded-xl" />
      )}
      <p className="text-sm font-medium text-fg-strong">First release</p>
    </div>
  );
}
