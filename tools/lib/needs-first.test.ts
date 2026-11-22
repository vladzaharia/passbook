import { describe, expect, it } from 'vitest';
import { firstDeployReasons } from './needs-first.ts';

const base = {
  workflows: [{ name: 'wallet-a' }],
  queues: { consumers: [{ queue: 'q1' }] },
  durable_objects: { bindings: [{ class_name: 'ScanHub' }] },
  exports: { ScanHub: {} },
  routes: [{ pattern: 'a.example', custom_domain: true }, { pattern: 'b.example/*' }],
};

describe('firstDeployReasons', () => {
  it('is empty when nothing is added', () => {
    expect(firstDeployReasons(base, { ...base, workflows: [] })).toEqual([]);
  });

  it('lists each added workflow, consumer, durable object, export and custom domain', () => {
    const next = {
      workflows: [...base.workflows, { name: 'wallet-b' }],
      queues: { consumers: [...base.queues.consumers, { queue: 'q2' }] },
      durable_objects: { bindings: [...base.durable_objects.bindings, { class_name: 'Hub2' }] },
      exports: { ...base.exports, Hub2: {} },
      routes: [...base.routes, { pattern: 'c.example', custom_domain: true }, 'd.example/*'],
    };
    expect(firstDeployReasons(base, next)).toEqual([
      'workflow wallet-b',
      'queue consumer q2',
      'durable object Hub2',
      'export Hub2',
      'custom domain c.example',
    ]);
  });

  it('treats a first-ever config as all new', () => {
    expect(firstDeployReasons({}, base)).toHaveLength(5);
  });
});
