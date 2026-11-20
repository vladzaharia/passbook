import { Validator } from '@cfworker/json-schema';

/** Errors from validating `value` against a schema of the OpenAPI document; `#/components/...` refs resolve in `doc`. */
export function validateAgainst(doc: object, schema: object, value: unknown): string[] {
  const root = JSON.parse(
    JSON.stringify({ ...schema, components: (doc as { components?: unknown }).components }),
  );
  const result = new Validator(root, '2020-12', false).validate(value);
  return result.valid ? [] : result.errors.map((e) => `${e.instanceLocation}: ${e.error}`);
}
