import type { ValidationIssue } from '@/passkit/types.ts';
import { bindingsOf, toOf } from './bindings.ts';
import {
  type DesignDoc,
  fieldsOf,
  type GroupId,
  groupsFor,
  keyOf,
  type Selection,
  styleOf,
} from './model.ts';

const COLORS = /^(backgroundColor|foregroundColor|labelColor|stripColor|footerBackgroundColor)\b/;
const RELEVANCE = /^(locations|beacons|relevantDates?|expirationDate|maxDistance)\b/;
const STYLE =
  /^(logoText|eventLogoText|description|organizationName|preferredStyleSchemes|useAutomaticColors|\w+\.transitType)\b/;

/** The part of the designer an issue is about, from its path; null when it has no home. */
export function issueTarget(issue: ValidationIssue, doc: DesignDoc): Selection | null {
  const path = issue.path ?? '';
  if (issue.code === 'MISSING_ICON') return { section: 'images', key: 'icon' };
  const png = /^(?:[\w-]+\.lproj\/)?([A-Za-z]+)(?:@[23]x)?\.png$/.exec(path);
  if (png) return { section: 'images', key: png[1] };
  const field = /^\w+\.(\w+Fields)\[(\d+)\]/.exec(path);
  if (field) {
    const group = field[1] as GroupId;
    if (!groupsFor(styleOf(doc.passJson)).includes(group)) return null;
    const key = keyOf(fieldsOf(doc.passJson, group)[Number(field[2])] ?? {});
    return { section: group, ...(key ? { key } : {}) };
  }
  if (/^barcodes?\b/.test(path)) return { section: 'barcode' };
  if (RELEVANCE.test(path)) return { section: 'relevance' };
  if (COLORS.test(path)) return { section: 'colors' };
  if (STYLE.test(path)) return { section: 'style' };
  const input = /^(?:inputs\/properties|sample)[/.]([A-Za-z_]\w*)/.exec(path);
  if (input) return { section: 'inputs', key: input[1] };
  if (/^(inputs|sample|display|requires)\b/.test(path)) return { section: 'inputs' };
  const binding = /^bindings\/(\d+)/.exec(path);
  if (binding) {
    const to = toOf(bindingsOf(doc.manifest)[Number(binding[1])] ?? {});
    if ('barcode' in to) return { section: 'barcode' };
    const key = typeof to.field === 'string' ? to.field : undefined;
    const group = key
      ? groupsFor(styleOf(doc.passJson)).find((g) =>
          fieldsOf(doc.passJson, g).some((f) => keyOf(f) === key),
        )
      : undefined;
    return group ? { section: group, key } : { section: 'inputs' };
  }
  if (path === 'name' || path === 'description') return { section: 'template' };
  return null;
}
