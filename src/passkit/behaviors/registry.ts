import type { BehaviorPlugin } from '../types.ts';

export interface BehaviorRegistry {
  get(id: string): BehaviorPlugin | undefined;
  list(): BehaviorPlugin[];
}

/** Registries are generated (src/generated/behaviors.ts); tests build their own. */
export function createBehaviorRegistry(plugins: BehaviorPlugin[]): BehaviorRegistry {
  const byId = new Map<string, BehaviorPlugin>();
  for (const plugin of plugins) {
    if (byId.has(plugin.id)) throw new Error(`Duplicate behavior plugin ${plugin.id}`);
    byId.set(plugin.id, plugin);
  }
  return { get: (id) => byId.get(id), list: () => [...byId.values()] };
}
