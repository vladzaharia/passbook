import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  OrgExportLinkSchema,
  OrgExportListSchema,
  OrgExportStartedSchema,
} from '@/shared/contracts/org-lifecycle.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/exports`;

/** The org's exports, newest first. Read once and again when one starts or ends: the operation does the live part. */
export function useExports(orgId: string) {
  const mode = useMode();
  return useQuery({
    queryKey: ['org-exports', orgId, mode],
    queryFn: () => api.get(base(orgId), OrgExportListSchema),
  });
}

export function useStartExport(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(base(orgId), OrgExportStartedSchema, {}),
    onSuccess: () => client.invalidateQueries({ queryKey: ['org-exports', orgId] }),
  });
}

/** A one-hour, one-download link: a separate authorized call, never part of the operation. */
export function useExportLink(orgId: string) {
  return useMutation({
    mutationFn: (exportId: string) =>
      api.post(`${base(orgId)}/${encodeURIComponent(exportId)}/link`, OrgExportLinkSchema, {}),
  });
}
