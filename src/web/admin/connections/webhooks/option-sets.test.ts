import { describe, expect, it } from 'vitest';
import { RotateWebhookSecretSchema } from '@/shared/contracts/webhook-secrets.ts';
import { SUBSCRIBABLE_EVENT_TYPES, WebhookEndpointSchema } from '@/shared/contracts/webhooks.ts';
import { EVENT_SETS, setOf } from './event-sets.ts';
import { EVENT_GROUP, OVERLAP_OPTIONS } from '../../../ui/webhooks/labels.ts';

describe('secret overlap options', () => {
  it('offers Now, 1 hour, 24 hours, 3 days and 7 days', () => {
    expect(OVERLAP_OPTIONS.map((o) => o.value)).toEqual(['0', '1', '24', '72', '168']);
  });

  it('are all accepted by the API contract', () => {
    for (const o of OVERLAP_OPTIONS)
      expect(RotateWebhookSecretSchema.safeParse({ overlapHours: Number(o.value) }).success).toBe(
        true,
      );
  });
});

describe('event quick picks', () => {
  it('offers six sets', () => {
    expect(EVENT_SETS.map((s) => s.label)).toEqual([
      'All',
      'Pass changes',
      'Wallet activity',
      'Scans',
      'Delivery',
      'Printing',
    ]);
  });

  it('only name real events, and All is every one', () => {
    for (const s of EVENT_SETS) {
      expect(s.types.length).toBeGreaterThan(0);
      for (const t of s.types) expect(SUBSCRIBABLE_EVENT_TYPES).toContain(t);
    }
    expect(EVENT_SETS[0]?.types).toEqual(SUBSCRIBABLE_EVENT_TYPES);
  });

  it('the Wallet, Scans and Delivery sets match their groups', () => {
    for (const [id, group] of [
      ['wallet', 'Wallet'],
      ['scans', 'Scans'],
      ['delivery', 'Delivery'],
    ] as const)
      expect(EVENT_SETS.find((s) => s.id === id)?.types).toEqual(
        SUBSCRIBABLE_EVENT_TYPES.filter((t) => EVENT_GROUP[t] === group),
      );
  });

  it('every event is in some set besides All, and the API takes each set', () => {
    const covered = new Set(EVENT_SETS.slice(1).flatMap((s) => s.types));
    expect([...covered].sort()).toEqual([...SUBSCRIBABLE_EVENT_TYPES].sort());
    expect(WebhookEndpointSchema.shape.eventTypes.safeParse(EVENT_SETS[1]?.types).success).toBe(
      true,
    );
  });

  it('names the set the ticks equal, in any order', () => {
    expect(setOf(['pass.uninstalled', 'pass.installed'])?.id).toBe('wallet');
    expect(setOf(['pass.installed'])).toBeUndefined();
  });
});
