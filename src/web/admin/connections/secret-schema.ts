/** Secret fields render as password inputs unless the schema picks another widget. */
export function secretSchema(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return schema;
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  if (!props) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(props).map(([key, def]) => [
        key,
        typeof def === 'object' && def !== null && !('x-widget' in def)
          ? { ...def, 'x-widget': 'password' }
          : def,
      ]),
    ),
  };
}
