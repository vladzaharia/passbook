export interface GroupableTemplate {
  name: string;
  orgId: string | null;
  orgName: string | null;
}

type Named = Pick<GroupableTemplate, 'name' | 'orgId' | 'orgName'>;

const SEPARATOR = ' · ';
const fold = (s: string) => s.replace(/[‘’]/g, "'").trim().toLowerCase();

/**
 * The name without a leading "Owner · " that repeats its group: "Acme · Gold" under Acme Fitness
 * is "Gold", "PassBook · Generic" under Shared is "Generic". Other prefixes stay; the stored name
 * never changes.
 */
export function displayName({ name, orgId, orgName }: Named): string {
  const at = name.indexOf(SEPARATOR);
  const rest = at > 0 ? name.slice(at + SEPARATOR.length).trim() : '';
  if (!rest) return name;
  const prefix = fold(name.slice(0, at));
  const owner = fold(orgId === null ? 'PassBook' : (orgName ?? ''));
  return owner === prefix || owner.startsWith(`${prefix} `) ? rest : name;
}

export interface TemplateGroup<T extends GroupableTemplate> {
  /** The org id, or "shared". */
  key: string;
  label: string;
  orgId: string | null;
  items: { template: T; name: string }[];
}

/**
 * The org's own templates first, under the org's name, then the shared ones every org can use
 * (orgId null). Order inside a group is the API's.
 */
export function groupTemplates<T extends GroupableTemplate>(
  templates: readonly T[],
  orgName?: string,
): TemplateGroup<T>[] {
  const groups = new Map<string, TemplateGroup<T>>();
  for (const template of templates) {
    const key = template.orgId ?? 'shared';
    let group = groups.get(key);
    if (!group) {
      const label =
        template.orgId === null ? 'Shared' : (template.orgName ?? orgName ?? 'Organization');
      group = { key, label, orgId: template.orgId, items: [] };
      groups.set(key, group);
    }
    group.items.push({ template, name: displayName(template) });
  }
  return [...groups.values()].sort((a, b) => Number(a.orgId === null) - Number(b.orgId === null));
}
