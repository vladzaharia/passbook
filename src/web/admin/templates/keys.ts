export interface TemplateFilters {
  orgId?: string | undefined;
  origin?: 'baked' | 'uploaded' | undefined;
  includeArchived?: boolean | undefined;
  q?: string | undefined;
  /** True lists blueprints; templates otherwise. */
  blueprint?: boolean | undefined;
}

/** Query keys of the template reads, free of the session client so a Workbench page can name them. */
export const templateKeys = {
  all: ['admin', 'templates'] as const,
  list: (f: TemplateFilters) => ['admin', 'templates', 'list', f] as const,
  detail: (id: string, orgId?: string) =>
    ['admin', 'templates', 'detail', id, orgId ?? null] as const,
  import: (id: string, orgId: string | undefined) =>
    ['admin', 'templates', 'import', id, orgId ?? null] as const,
};
