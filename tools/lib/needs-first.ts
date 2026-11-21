/** Resources that only `wrangler deploy` can register (see tools/deploy.ts). */
type Config = {
  workflows?: { name: string }[];
  queues?: { consumers?: { queue: string }[] };
  durable_objects?: { bindings?: { class_name: string }[] };
  exports?: Record<string, unknown>;
  routes?: (string | { pattern: string; custom_domain?: boolean })[];
};

function registered(config: Config): Set<string> {
  const out = new Set<string>();
  for (const w of config.workflows ?? []) out.add(`workflow ${w.name}`);
  for (const c of config.queues?.consumers ?? []) out.add(`queue consumer ${c.queue}`);
  for (const b of config.durable_objects?.bindings ?? []) out.add(`durable object ${b.class_name}`);
  for (const name of Object.keys(config.exports ?? {})) out.add(`export ${name}`);
  for (const r of config.routes ?? [])
    if (typeof r === 'object' && r.custom_domain) out.add(`custom domain ${r.pattern}`);
  return out;
}

/** What `next` registers that `previous` did not. Non-empty means deploy with --first. */
export function firstDeployReasons(previous: Config, next: Config): string[] {
  const had = registered(previous);
  return [...registered(next)].filter((item) => !had.has(item));
}
