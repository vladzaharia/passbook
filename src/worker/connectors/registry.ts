import { connectorDefinitions } from '../../generated/connectors.ts';
import type { AnyConnector as ConnectorDefinition } from './types.ts';

export interface ConnectorRegistry {
  get(type: string): ConnectorDefinition | undefined;
  list(): ConnectorDefinition[];
}

export function defineRegistry(definitions: readonly ConnectorDefinition[]): ConnectorRegistry {
  const byType = new Map<string, ConnectorDefinition>();
  for (const definition of definitions as readonly ConnectorDefinition[]) {
    if (byType.has(definition.type)) throw new Error(`Duplicate connector ${definition.type}`);
    byType.set(definition.type, definition);
  }
  return { get: (type) => byType.get(type), list: () => [...byType.values()] };
}

/** Generated from src/worker/connectors/<type>/index.ts by `npm run gen`. */
export const connectors: ConnectorRegistry = defineRegistry(connectorDefinitions);
