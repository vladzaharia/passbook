import { type Api, GENERIC_BLUEPRINT } from './api.ts';

/**
 * Clones the generic blueprint with the barcode carrying the member ID (Henry's style), so a camera
 * read of the member ID is a barcode hit. A lookup-only camera read is a staff check, by design.
 * Returns the clone shaped like the clone response, pointing at the saved version.
 */
export async function cloneMemberBarcode(api: Api, orgId: string, name: string) {
  const template = await api.send(
    'POST',
    `/api/v1/templates/${encodeURIComponent(GENERIC_BLUEPRINT)}/clone`,
    { orgId, name },
  );
  const initial = template.versions[0]?.version;
  if (!initial) throw new Error(`Template ${template.id} has no initial version`);
  const detail = await api.get(`/api/v1/templates/${template.id}/versions/${initial}`);
  const manifest = structuredClone(detail.manifest);
  for (const binding of manifest.bindings)
    if (binding.to?.barcode !== undefined && binding.to.prop === 'message')
      binding.value = '{{memberId}}';
  const saved = await api.send('POST', `/api/v1/templates/${template.id}/versions`, {
    manifest,
    passJson: detail.passJson,
    assets: detail.assets.map((a: { name: string; sha1: string }) => ({
      name: a.name,
      sha1: a.sha1,
    })),
  });
  if (!saved.saved || !saved.version)
    throw new Error(`Template ${template.id} not saved: ${JSON.stringify(saved.report)}`);
  return { ...template, versions: [{ version: saved.version as string }] };
}
