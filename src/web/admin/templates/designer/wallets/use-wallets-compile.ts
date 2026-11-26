import { useWalletPreviews } from '../../../../channel-previews/use-wallet-previews.ts';
import { useDesigner } from '../context.tsx';
import { useStageSource } from '../stage-source.ts';

/**
 * Google and Samsung compiled from the draft in the render that changed it: the manifest is the
 * draft's own, so a role, type, omit, required or art edit reaches the report, the rail and the
 * card together. The compiler chunk loads when the tab opens.
 */
export function useWalletsCompile(passJson: Record<string, unknown> | null | undefined) {
  const { doc, assetBase, orgId } = useDesigner();
  const { source } = useStageSource({
    manifest: doc.manifest,
    passJson,
    assets: doc.assets,
    assetBase,
    orgId,
  });
  return useWalletPreviews(source);
}
