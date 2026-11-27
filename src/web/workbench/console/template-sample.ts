import { PORTAL_READ } from '../playground/live.ts';
import type { Transport } from './client.ts';
import type { Json, RunSchema } from './types.ts';

/** What the sandbox template says about its own `input`: a sample that passes, and the schema it is held to. */
export interface TemplateInput {
  sample: Json | undefined;
  schema: RunSchema | undefined;
}

const loaded = new Map<string, Promise<TemplateInput>>();
const NONE: TemplateInput = { sample: undefined, schema: undefined };

async function read(templateId: string, send: Transport): Promise<TemplateInput> {
  const path = `/api/v1/templates/${encodeURIComponent(templateId)}`;
  // A read counts against the same per-minute limit as a Run, so it counts in the gauge too.
  const res = await send(path, { headers: { accept: 'application/json', ...PORTAL_READ } });
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
export function loadTemplateInput(templateId: string, send: Transport): Promise<TemplateInput> {
  let p = loaded.get(templateId);
  if (!p) {
    p = read(templateId, send)
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
  firstOf.clear();
}

const firstOf = new Map<string, Promise<string | null>>();

/** The first template of the org the client calls as: the example's own, so the first Run works. Null when there is none. */
export function firstTemplateId(orgId: string, send: Transport): Promise<string | null> {
  let p = firstOf.get(orgId);
  if (!p) {
    p = send('/api/v1/templates?limit=1', {
      headers: { accept: 'application/json', ...PORTAL_READ },
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as { items?: { id?: unknown }[] };
        const id = body.items?.[0]?.id;
        return typeof id === 'string' ? id : null;
      })
      .catch(() => null)
      .then((id) => {
        if (id === null) firstOf.delete(orgId);
        return id;
      });
    firstOf.set(orgId, p);
  }
  return p;
}
