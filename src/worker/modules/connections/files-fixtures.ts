import { vi } from 'vitest';
import { z } from 'zod';
import demo from '../../connectors/demo/index.ts';
import { connectors } from '../../connectors/registry.ts';
import type { AnyConnector } from '../../connectors/types.ts';
import * as service from './service.ts';
import type { Kit } from './test-kit.ts';

/** The demo connector with the upload capability and an ID column, standing in for file-upload. */
export const uploadConnector: AnyConnector = {
  ...demo,
  capabilities: { ...demo.capabilities, upload: true },
  configSchema: z.object({ idColumn: z.string(), sheet: z.string().optional() }) as never,
};

/** Makes `connectors.get('demo')` the upload connector until the spy is restored. */
export function useUploadConnector(): void {
  const original = connectors.get.bind(connectors);
  vi.spyOn(connectors, 'get').mockImplementation((type) =>
    type === 'demo' ? uploadConnector : original(type),
  );
}

export const csvBody = (rows: string[][], name = 'members.csv') => ({
  name,
  content: rows.map((r) => r.join(',')).join('\n'),
  encoding: 'utf8' as const,
});

export const MEMBERS = [
  ['id', 'name', 'email', 'joined'],
  ['m-1', 'Ada', 'ada@example.com', '2026-01-02'],
  ['m-2', 'Grace', 'grace@example.com', '2026-02-03'],
  ['m-3', 'Linus', 'linus@example.com', '2026-03-04'],
];

type Create = Parameters<typeof service.create>[2];

/** Creates a manual file-upload connection bound to `fileId`. */
export function createUpload(kit: Kit, fileId: string, over: Partial<Create> = {}) {
  return service.create(kit.sctx, kit.actor, {
    orgId: kit.org.id,
    connectorType: 'demo',
    name: 'Members file',
    config: { idColumn: '/id' },
    mode: 'manual',
    fileId,
    ...over,
  } as Create);
}
