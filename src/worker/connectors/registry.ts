import { connectorDefinitions } from '../../generated/connectors.ts';
import { type AnyConnector as ConnectorDefinition, legacyFlags } from './types.ts';

export interface ConnectorRegistry {
  get(type: string): ConnectorDefinition | undefined;
  list(): ConnectorDefinition[];
}

const FLAG_KEYS = ['poll', 'delta', 'webhook', 'import', 'snapshot', 'upload'] as const;

/** Every way a declaration can disagree with the methods present; empty when it matches. */
function mismatches(d: ConnectorDefinition): string[] {
  const caps = d.capabilities;
  const read = caps.read ?? {};
  const webhook = caps.inbound?.webhook ?? 'none';
  const writes = Object.entries(caps.write?.objects ?? {});
  const writesSomething = writes.length > 0 || (caps.outbound?.events.length ?? 0) > 0;
  const has = (m: keyof ConnectorDefinition) => typeof d[m] === 'function';
  const out: string[] = [];
  const need = (ok: unknown, message: string) => {
    if (!ok) out.push(message);
  };

  need(
    !has('listChanges') || read.list || read.upload,
    'listChanges needs read.list or read.upload',
  );
  need(!read.list || has('listChanges'), 'read.list needs listChanges');
  need(!read.upload || has('listChanges'), 'read.upload needs listChanges');
  need(!read.delta || read.list, 'read.delta needs read.list');
  need(!!read.import === has('importRecords'), 'read.import and importRecords go together');
  need(
    (webhook !== 'none') === has('verifyWebhook'),
    'inbound.webhook and verifyWebhook go together',
  );
  const managedMethods = has('registerWebhooks') && has('unregisterWebhooks');
  need(
    webhook === 'managed' ? managedMethods : !has('registerWebhooks') && !has('unregisterWebhooks'),
    'managed webhooks need registerWebhooks and unregisterWebhooks, and only managed may have them',
  );
  need(!has('renewWebhooks') || webhook === 'managed', 'renewWebhooks needs managed webhooks');
  need(
    writesSomething === (has('mapEvent') && has('write')) && has('mapEvent') === has('write'),
    'write.objects or outbound.events need mapEvent and write, and mapEvent and write need them',
  );
  for (const [object, ops] of writes) {
    need(d.objects?.[object], `written object ${object} is not in the objects catalog`);
    need(
      ops.length > 0 && new Set(ops).size === ops.length,
      `written object ${object} needs distinct ops`,
    );
  }
  for (const [object, entry] of Object.entries(d.objects ?? {})) {
    for (const [field, f] of Object.entries(entry.fields)) {
      need(f.direction !== 'both' || f.master, `two-way field ${object}.${field} needs a master`);
    }
    const outgoing = Object.values(entry.fields).some((f) => f.direction !== 'in');
    need(
      !outgoing || caps.write?.objects[object],
      `object ${object} has outgoing fields but is not written`,
    );
  }
  need((caps.auth === 'oauth2') === (d.oauth !== undefined), 'auth oauth2 and oauth go together');
  need(
    caps.auth !== 'none' || (d.secretSchema === undefined && webhook === 'none'),
    'auth none allows no secretSchema and no inbound webhook',
  );
  need(
    caps.auth !== 'secret' || d.secretSchema !== undefined || webhook !== 'none',
    'auth secret needs a secretSchema or an inbound webhook',
  );
  const derived = legacyFlags(caps);
  need(
    FLAG_KEYS.every((k) => k === 'snapshot' || caps[k] === derived[k]),
    'capability flags must come from declareCapabilities',
  );
  return out;
}

export function defineRegistry(definitions: readonly ConnectorDefinition[]): ConnectorRegistry {
  const byType = new Map<string, ConnectorDefinition>();
  for (const definition of definitions as readonly ConnectorDefinition[]) {
    if (byType.has(definition.type)) throw new Error(`Duplicate connector ${definition.type}`);
    const problems = mismatches(definition);
    if (problems.length > 0) {
      throw new Error(`Connector ${definition.type} declaration mismatch: ${problems.join('; ')}`);
    }
    byType.set(definition.type, definition);
  }
  return { get: (type) => byType.get(type), list: () => [...byType.values()] };
}

/** Generated from src/worker/connectors/<type>/index.ts by `npm run gen`. */
export const connectors: ConnectorRegistry = defineRegistry(connectorDefinitions);
