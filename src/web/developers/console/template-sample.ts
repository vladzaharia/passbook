import { PORTAL_READ } from '../playground/live.ts';
import { spend } from './budget.ts';
import { drop, token } from './token.ts';
import type { Json, RunSchema } from './types.ts';

/** What the sandbox template says about its own `input`: a sample that passes, and the schema it is held to. */
export interface TemplateInput {
  sample: Json | undefined;
  schema: RunSchema | undefined;
}

const loaded = new Map<string, Promise<TemplateInput>>();
const NONE: TemplateInput = { sample: undefined, schema: undefined };

async function get(path: string, csrf: string): Promise<Response> {
  const bearer = await token(csrf);
  // A read counts against the same per-minute limit as a Run, so it counts in the gauge too.
  spend();
  return fetch(path, {
    redirect: 'error',
    headers: { accept: 'application/json', ...PORTAL_READ, authorization: `Bearer ${bearer}` },
  });
}

async function read(templateId: string, csrf: string): Promise<TemplateInput> {
  const path = `/api/v1/templates/${encodeURIComponent(templateId)}`;
  let res = await get(path, csrf);
  // A stale token is refused as UNAUTHENTICATED: forget it and ask once more.
  if (res.status === 401) {
    drop();
    res = await get(path, csrf);
  }
  if (!res.ok) return NONE;
  const detail = (await res.json()) as Json;
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return NONE;
  const schema = detail.inputSchema;
  return {
    sample: detail.sample,
    schema:
      schema !== null && typeof schema === 'object' && !Array.isArray(schema)
        ? (schema as RunSchema)
        : undefined,
  };
}

/**
 * The template's `sample` and input schema from one read, kept for the page. A read that fails leaves both out
 * and is not kept: the example stays as written and a later call asks again.
 */
export function loadTemplateInput(templateId: string, csrf: string): Promise<TemplateInput> {
  let p = loaded.get(templateId);
  if (!p) {
    p = read(templateId, csrf)
      .catch(() => NONE)
      .then((got) => {
        if (got.sample === undefined && got.schema === undefined) loaded.delete(templateId);
        return got;
      });
    loaded.set(templateId, p);
  }
  return p;
}

/** Forgets every read (used by tests; a page reload does the same). */
export function resetTemplateInput(): void {
  loaded.clear();
}
