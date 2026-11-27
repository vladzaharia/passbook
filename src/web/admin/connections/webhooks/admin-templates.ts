import { useOrgScope } from '../../../lib/org-filter.tsx';
import { useTemplates } from '../../templates/api.ts';
import type { TemplateChoices } from './endpoint-fields.tsx';

/** Admin's templates for the endpoint form: the caller's `templates:read`, read through the session. */
export function useAdminTemplateChoices(
  orgId: string | undefined,
  selected: boolean,
): TemplateChoices {
  const scope = useOrgScope();
  const canList = Boolean(scope.membership?.capabilities.includes('templates:read'));
  const templates = useTemplates({ orgId }, Boolean(orgId) && canList && selected);
  return { canList, items: templates.data?.items ?? [], loading: templates.isPending };
}
