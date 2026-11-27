import { DEV_GUIDES } from '../../../shared/copy/developers.ts';
import { PATHS, twin } from '../../../shared/developers.ts';
import { wbHref } from '../../../shared/workbench.ts';
import { pagePath } from '../model/markdown.ts';
import type { Example, Json, Method, Site } from '../model/types.ts';
import { blockTexts, type GuideDoc, GuideError, linksIn } from './parse.ts';

/** A snippet's query and body, read to prove the snippet is a request the Console can run. */
export interface Prefill {
  body?: Json;
  query?: Record<string, string>;
}

/**
 * The Workbench's Console on an operation: `?op=<operationId>&sample=<snippetId>`. The body comes from
 * the operation's own sample or the named snippet in the docs build, never from the URL (L19).
 */
export function consoleHref(opId: string, sample?: string): string {
  return wbHref('console', { query: { op: opId, sample } });
}

/** A curl snippet's query and body. Anything else it carries (path ids, headers) is the reader's to set. */
export function prefillFromCurl(curl: string, where: string): Prefill {
  const line = curl.replaceAll('\\\n', ' ');
  const url = /"(https:[^"]+)"/.exec(line)?.[1];
  if (!url) throw new GuideError(`${where}: no URL in the curl snippet`);
  const out: Prefill = {};
  const query = Object.fromEntries(new URL(url).searchParams);
  if (Object.keys(query).length > 0) out.query = query;
  const body = /-d '([\s\S]*)'\s*$/.exec(line)?.[1];
  if (body !== undefined)
    try {
      out.body = JSON.parse(body) as Json;
    } catch {
      throw new GuideError(`${where}: the curl body is not JSON`);
    }
  return out;
}

export interface GuideOp {
  operationId: string;
  method: Method;
  path: string;
  title: string;
  sdkCall: string;
  /** The reference page and anchor. */
  href: string;
}

/** One runnable step: the Workbench link and what it opens. */
export interface RunStep {
  opId: string;
  href: string;
  /** Index of its block in the guide. */
  block: number;
  /** The snippet it came from; a body fence has none. */
  snippet?: string;
}

export interface Guide extends GuideDoc {
  url: string;
  ops: GuideOp[];
  steps: RunStep[];
}

export const guideUrl = (id: string): string => `${PATHS.guides}/${id}`;

const CONSOLE = 'console:';

export function opIndex(site: Site): Map<string, GuideOp> {
  const out = new Map<string, GuideOp>();
  for (const page of site.pages)
    for (const o of page.ops)
      out.set(o.operationId, {
        operationId: o.operationId,
        method: o.method,
        path: o.path,
        title: o.title,
        sdkCall: o.sdkCall,
        href: `${pagePath(page)}#${o.anchor}`,
      });
  return out;
}

/** Resolves a guide against the snippets and the operations; throws on a reference that points nowhere. */
export function resolveGuide(doc: GuideDoc, site: Site, examples: Example[]): Guide {
  const ops = opIndex(site);
  const snippets = new Map(examples.map((e) => [e.id, e]));
  const { id } = doc.meta;
  const used: string[] = [];
  const steps: RunStep[] = [];
  const need = (opId: string, where: string): string => {
    if (!ops.has(opId))
      throw new GuideError(`${id}: ${where}: no operation ${opId} a key can call`);
    if (!used.includes(opId)) used.push(opId);
    return opId;
  };
  const snippet = (name: string): Example => {
    const e = snippets.get(name);
    if (!e) throw new GuideError(`${id}: no snippet ${name} in docs/developers/snippets/guides`);
    for (const op of e.ops) need(op, `snippet ${name}`);
    return e;
  };
  for (const [block, b] of doc.blocks.entries()) {
    if (b.kind === 'show') snippet(b.snippet);
    else if (b.kind === 'run') {
      const e = snippet(b.snippet);
      const [opId, ...more] = e.ops;
      if (!e.curl || !opId || more.length > 0)
        throw new GuideError(
          `${id}: run ${b.snippet} needs one operation and a curl snippet; use show`,
        );
      prefillFromCurl(e.curl, `${id}: ${b.snippet}`);
      steps.push({ opId, href: consoleHref(opId, b.snippet), block, snippet: b.snippet });
    } else if (b.kind === 'code' && b.run) {
      need(b.run, 'run fence');
      try {
        JSON.parse(b.text);
      } catch {
        throw new GuideError(`${id}: the run=${b.run} fence is not JSON`);
      }
      steps.push({ opId: b.run, href: consoleHref(b.run), block });
    } else
      for (const text of blockTexts(b))
        for (const l of linksIn(text))
          if (l.target.startsWith(CONSOLE)) need(l.target.slice(CONSOLE.length), 'console link');
  }
  for (const op of doc.meta.ops) need(op, 'header ops');
  const named = DEV_GUIDES.find((g) => g.id === id);
  return {
    ...doc,
    meta: named ? { ...doc.meta, title: named.title, line: named.line } : doc.meta,
    url: guideUrl(id),
    ops: used.flatMap((o) => ops.get(o) ?? []),
    steps,
  };
}

/** Where an inline link goes: a console link opens the operation in the console; the rest is as written. */
export function hrefOf(target: string): string {
  return target.startsWith(CONSOLE) ? consoleHref(target.slice(CONSOLE.length)) : target;
}

export const GUIDE_TWIN = (id: string): string => twin(guideUrl(id));
