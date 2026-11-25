import { token } from './token.ts';
import type { Json, RunSchema } from './types.ts';

/** What the sandbox template says about its own `input`: a sample that passes, and the schema it is held to. */
export interface TemplateInput {
  sample: Json | undefined;
  schema: RunSchema | undefined;
}

const loaded = new Map<string, Promise<TemplateInput>>();

async function read(path: string, bearer: string): Promise<Json | undefined> {
  const res = await fetch(path, {
    headers: { accept: 'application/json', authorization: `Bearer ${bearer}` },
  });
  return res.ok ? ((await res.json()) as Json) : undefined;
}

/** The template's `sample` and input schema, read once. A read that fails leaves both out: the example stays as written. */
export function loadTemplateInput(templateId: string, csrf: string): Promise<TemplateInput> {
  let p = loaded.get(templateId);
  if (!p) {
    const id = encodeURIComponent(templateId);
    p = token(csrf)
      .then(async (bearer) => {
        const [detail, schema] = await Promise.all([
          read(`/api/v1/templates/${id}`, bearer),
          read(`/api/v1/templates/${id}/input-schema`, bearer),
        ]);
        const sample =
          detail !== null && typeof detail === 'object' && !Array.isArray(detail)
            ? detail.sample
            : undefined;
        return { sample, schema: schema as RunSchema | undefined };
      })
      .catch((): TemplateInput => ({ sample: undefined, schema: undefined }))
      .then((got) => {
        if (got.sample === undefined && got.schema === undefined) loaded.delete(templateId);
        return got;
      });
    loaded.set(templateId, p);
  }
  return p;
}

/** Forgets what was read, for tests and for a sandbox that was reset. */
export function resetTemplateInput(): void {
  loaded.clear();
}
