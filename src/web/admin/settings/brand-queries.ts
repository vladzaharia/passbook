import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrandKitSchema, WEB_LOGO } from '@/shared/contracts/brand.ts';
import { OrgSchema } from '@/shared/contracts/orgs.ts';
import { api } from '@/web/lib/api.ts';
import { ImageInputError, pngSize, toBase64 } from '../orgs/branding.ts';
import { orgKeys } from '../orgs/queries.ts';

const PATH = '/api/v1/brand';
const keyOf = (orgId: string) => ['admin', 'brand', orgId] as const;

export function useBrandKit(orgId: string) {
  return useQuery({
    queryKey: keyOf(orgId),
    queryFn: ({ signal }) => api.get(PATH, BrandKitSchema, { query: { orgId }, signal }),
  });
}

/** Saves, then refreshes the kit and the org (its branding feeds other pages). */
export function useBrandMutations(orgId: string) {
  const client = useQueryClient();
  const done = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keyOf(orgId) }),
      client.invalidateQueries({ queryKey: orgKeys.all }),
    ]);
  const query = { query: { orgId } };
  return {
    update: useMutation({
      mutationFn: (body: { accent?: string | null; mark?: string; configRevision?: number }) =>
        api.patch(PATH, OrgSchema, body, query),
      onSuccess: done,
    }),
    upload: useMutation({
      mutationFn: (body: { png: string; configRevision?: number }) =>
        api.put(`${PATH}/web-logo`, OrgSchema, body, query),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (configRevision?: number) =>
        api.deleteJson(`${PATH}/web-logo`, OrgSchema, {
          query: { orgId, ...(configRevision === undefined ? {} : { configRevision }) },
        }),
      onSuccess: done,
    }),
  };
}

/** Checks a web logo in the browser, so the common mistakes never leave the page. */
export async function prepareWebLogo(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = pngSize(bytes);
  if (!size) throw new ImageInputError('Choose a PNG file.');
  if (bytes.length > WEB_LOGO.maxBytes) throw new ImageInputError('The logo is over 512 KB.');
  if (size.w > WEB_LOGO.maxWidth || size.h > WEB_LOGO.maxHeight)
    throw new ImageInputError(
      `The logo is ${size.w} × ${size.h} px; use at most ${WEB_LOGO.maxWidth} × ${WEB_LOGO.maxHeight}.`,
    );
  if (size.w < WEB_LOGO.minSide || size.h < WEB_LOGO.minSide)
    throw new ImageInputError(`Use at least ${WEB_LOGO.minSide} px on each side.`);
  return toBase64(bytes);
}
