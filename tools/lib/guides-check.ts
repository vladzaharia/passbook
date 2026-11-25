// Guide checks for check-developers: ids against DEV_GUIDES, snippets and operations that exist, links
// that resolve, and the owner's rule that a sandbox guide ends at a preview and has no phone steps.
import { DEV_GUIDES } from '../../src/shared/copy/developers.ts';
import { PATHS } from '../../src/shared/developers.ts';
import { guideUrl, resolveGuide } from '../../src/web/developers/guide/model.ts';
import {
  blockTexts,
  type GuideDoc,
  linksIn,
  parseGuide,
} from '../../src/web/developers/guide/parse.ts';
import { pagePath } from '../../src/web/developers/model/markdown.ts';
import type { Example, Site } from '../../src/web/developers/model/types.ts';

const PHONE_STEP = /\b(your phone|iphone|android|add to wallet|scan the qr)\b/i;
const OUTSIDE = new Set<string>([PATHS.assets, PATHS.openapi, PATHS.previews]);

/** Every internal URL a guide may link to, with the anchors a link may name on it (null: none checked). */
function targets(site: Site, docs: GuideDoc[]): Map<string, Set<string> | null> {
  const out = new Map<string, Set<string> | null>();
  for (const url of Object.values(PATHS)) if (!OUTSIDE.has(url)) out.set(url, null);
  for (const p of site.pages)
    out.set(pagePath(p), new Set(p.ops.flatMap((o) => [o.anchor, o.operationId])));
  for (const e of site.errors) out.set(`${PATHS.errors}/${e.code}`, null);
  for (const d of docs)
    out.set(
      guideUrl(d.meta.id),
      new Set(d.blocks.flatMap((b) => (b.kind === 'h2' || b.kind === 'h3' ? [b.id] : []))),
    );
  return out;
}

export function guideFailures(
  files: { file: string; text: string }[],
  examples: Example[],
  site: Site,
): string[] {
  const out: string[] = [];
  const docs: { file: string; doc: GuideDoc }[] = [];
  for (const { file, text } of files)
    try {
      docs.push({ file, doc: parseGuide(text, file) });
    } catch (e) {
      out.push(e instanceof Error ? e.message : String(e));
    }
  const seen = new Set<string>();
  for (const { file, doc } of docs) {
    const { id, title, line, status } = doc.meta;
    const named = DEV_GUIDES.find((g) => g.id === id);
    if (file.split('/').at(-1) !== `${id}.md`)
      out.push(`${file}: id ${id} must match the file name`);
    if (!named) out.push(`${file}: ${id} is not in DEV_GUIDES`);
    else if (named.title !== title)
      out.push(`${file}: title ${title} differs from DEV_GUIDES (${named.title})`);
    else if (named.line !== line)
      out.push(`${file}: line ${line} differs from DEV_GUIDES (${named.line})`);
    if (seen.has(id)) out.push(`${file}: duplicate id ${id}`);
    seen.add(id);
    if (id === 'nfc' && status !== 'preview')
      out.push(`${file}: the NFC guide is labelled preview`);
    try {
      const guide = resolveGuide(doc, site, examples);
      if (status !== 'soon' && guide.steps.length === 0)
        out.push(`${file}: no runnable step ({{run}} or a json fence with run=)`);
    } catch (e) {
      out.push(e instanceof Error ? e.message : String(e));
    }
    const heads = doc.blocks.filter((b) => b.kind === 'h2');
    if (
      status !== 'soon' &&
      heads.at(-1)?.kind === 'h2' &&
      (heads.at(-1) as { text: string }).text !== 'Result'
    )
      out.push(`${file}: the last section must be "Result", the preview outcome`);
  }
  for (const g of DEV_GUIDES)
    if (!seen.has(g.id)) out.push(`docs/developers/guides/${g.id}.md: missing`);
  const known = targets(
    site,
    docs.map((d) => d.doc),
  );
  for (const { file, doc } of docs)
    for (const text of doc.blocks.flatMap(blockTexts)) {
      if (PHONE_STEP.test(text)) out.push(`${file}: phone step in "${text.slice(0, 50)}"`);
      for (const { target } of linksIn(text)) {
        if (target.startsWith('console:') || /^https?:\/\//.test(target)) continue;
        const [path = '', hash] = target.split('#');
        const anchors = known.get(path);
        if (anchors === undefined) out.push(`${file}: link ${target} points at no page`);
        else if (hash && anchors && !anchors.has(hash))
          out.push(`${file}: link ${target} has no such anchor`);
      }
    }
  return out;
}
