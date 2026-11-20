import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { describeSchema, type FieldDef, flatFields } from '../passes/schema-form/index.ts';

/** Inputs every template has, with the first template's labels and widgets. */
export function commonFields(details: readonly z.infer<typeof TemplateDetailSchema>[]): FieldDef[] {
  const first = details[0];
  if (!first) return [];
  const others = details.slice(1).map((d) => {
    const props = (d.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    return new Set(Object.keys(props));
  });
  return flatFields(describeSchema(first.inputSchema)).filter(
    (f) => f.type !== 'array' && others.every((set) => set.has(f.key)),
  );
}
