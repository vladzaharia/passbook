import { describe, expect, it } from 'vitest';
import { scanOf } from '../../../shared/scan-defaults.ts';
import { scopeOf } from './card-projection.ts';
import { buildDisplay } from './display.ts';
import { AUTH, createDisplayFixture, ctx, HIDDEN_COUNT, NOW } from './display-split-fixture.ts';

const { actorOf, fixture, inputOf } = createDisplayFixture();

describe('live scanner display privacy', () => {
  it('limits history and scan values to visible inputs while preserving exit state', () => {
    const found = fixture();
    const input = inputOf(found, 'door');
    expect(scopeOf(ctx, input, found).history).toEqual({});
    input.scan = {
      input: 'hiddenCount',
      before: HIDDEN_COUNT,
      after: HIDDEN_COUNT,
      direction: 'out',
    };
    input.history = {
      visits: { total: 3 },
      list: {
        scans: [{ at: NOW, label: 'Check in', amount: HIDDEN_COUNT }],
        value: { hiddenCount: [{ at: NOW, amount: HIDDEN_COUNT }] },
      },
      ledger: { hiddenCount: { last: { at: NOW, amount: HIDDEN_COUNT } } },
      passJson: { token: AUTH },
    };
    const scope = scopeOf(ctx, input, found);
    expect(scope.scan).toMatchObject({ direction: 'out', outcome: 'ok' });
    expect(scope.scan).not.toHaveProperty('before');
    expect(scope.history).toEqual({});
    expect(JSON.stringify(scope.history)).not.toContain(String(HIDDEN_COUNT));
    expect(JSON.stringify(scope.history)).not.toContain(AUTH);

    input.actor = actorOf('desk');
    input.scan = { input: 'points', before: 5, after: 7, amount: 2, direction: 'out' };
    expect(scopeOf(ctx, input, found).scan).toMatchObject({
      input: 'points',
      before: 5,
      after: 7,
      amount: 2,
      direction: 'out',
    });
  });

  it('uses the action input as provenance only when an explicit source is absent', () => {
    const found = fixture();
    const input = inputOf(found, 'door');
    input.scan = { action: { id: 'points' }, before: 5, after: 7, amount: 2 };
    expect(scopeOf(ctx, input, found).scan).not.toHaveProperty('before');
    input.actor = actorOf('desk');
    expect(scopeOf(ctx, input, found).scan).toMatchObject({ before: 5, after: 7, amount: 2 });
    input.scan = {
      action: { id: 'points' },
      input: 'hiddenCount',
      before: 5,
      after: 7,
      amount: 2,
    };
    expect(scopeOf(ctx, input, found).scan).not.toHaveProperty('before');
    input.scan = { action: { id: 'unknown' }, before: 5, after: 7 };
    expect(scopeOf(ctx, input, found).scan).not.toHaveProperty('before');
  });

  it('retains the exit direction even when a hidden input has the same value', () => {
    const found = fixture();
    found.pass.personalization.privateNotes = 'out';
    const input = inputOf(found, 'door');
    input.scan = { direction: 'out' };
    expect(scopeOf(ctx, input, found).scan).toMatchObject({ direction: 'out', outcome: 'ok' });
  });

  it('requires the action role and matching current source for labels, values and rewards', () => {
    const found = fixture();
    found.template.manifest.inputs.properties!.points = { type: 'integer', 'x-scan': 'door' };
    found.template.manifest.scan!.actions.push({
      id: 'redeem',
      label: 'Redeem',
      kind: 'take',
      input: 'points',
      minRole: 'manager',
      amount: 10,
      rewardLabel: 'Private reward',
    });
    found.scan = scanOf(found.template.manifest);
    for (const role of ['door', 'desk', 'manager'] as const) {
      const input = inputOf(found, role);
      input.scan = {
        action: { id: 'redeem', label: 'Redeem', kind: 'take' },
        input: 'points',
        amount: 1,
        before: 6,
        after: 7,
      };
      const scope = scopeOf(ctx, input, found);
      if (role === 'manager') {
        expect(scope.goals).toMatchObject({ points: { goal: 10, reward: 'Private reward' } });
        expect(scope.scan).toMatchObject({ action: { label: 'Redeem' }, before: 6, after: 7 });
      } else {
        expect(scope.goals).not.toHaveProperty('points');
        expect(scope.scan).not.toHaveProperty('action');
        expect(scope.scan).not.toHaveProperty('before');
        expect(JSON.stringify(scope)).not.toContain('Private reward');
      }
    }
    const active = {
      ...found.template,
      version: 'v2',
      manifest: structuredClone(found.template.manifest),
    };
    active.manifest.scan!.actions.find((action) => action.id === 'redeem')!.input = 'seat';
    found.activePolicy = active;
    found.activeTemplate = found.template;
    found.activeVersion = active.version;
    const input = inputOf(found, 'manager');
    input.scan = {
      action: { id: 'redeem', label: 'Redeem', kind: 'take' },
      input: 'points',
      before: 6,
      after: 7,
    };
    const drifted = scopeOf(ctx, input, found);
    expect(drifted.goals).not.toHaveProperty('points');
    expect(drifted.scan).not.toHaveProperty('action');
    expect(drifted.scan).not.toHaveProperty('before');
  });

  it('honors a stricter current action role even when its source stays public', () => {
    const found = fixture();
    found.template.manifest.inputs.properties!.points = { type: 'integer', 'x-scan': 'door' };
    const active = {
      ...found.template,
      version: 'v2',
      manifest: structuredClone(found.template.manifest),
    };
    active.manifest.scan!.actions.find((action) => action.id === 'points')!.minRole = 'manager';
    found.activePolicy = active;
    found.activeTemplate = found.template;
    found.activeVersion = active.version;
    for (const role of ['desk', 'manager'] as const) {
      const input = inputOf(found, role);
      input.scan = { action: { id: 'points' }, input: 'points', before: 5, after: 7 };
      const scope = scopeOf(ctx, input, found);
      expect(scope.inputs).toHaveProperty('points');
      if (role === 'manager') expect(scope.scan).toMatchObject({ before: 5, after: 7 });
      else {
        expect(scope.scan).not.toHaveProperty('action');
        expect(scope.scan).not.toHaveProperty('before');
      }
    }
  });

  it('does not treat raw history names, actions or values as event-time proof', () => {
    const found = fixture();
    const input = inputOf(found, 'manager');
    input.history = {
      scans: { total: 1 },
      lastScan: { at: NOW, where: 'Unproven scanner', action: 'Unproven action' },
      list: {
        scans: [{ at: NOW, where: 'Unproven scanner', label: 'Unproven action' }],
        value: { points: [{ at: NOW, amount: 49, after: 56, label: 'Unproven action' }] },
      },
      ledger: { points: { last: { at: NOW, amount: 49 } } },
    };
    found.scan.display = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: { subtitle: '{{history.lastScan.action}}' },
      panels: [
        {
          id: 'p_history',
          rows: [{ id: 'r_history', type: 'history', source: 'scans', show: ['action', 'where'] }],
        },
      ],
    };
    const scope = scopeOf(ctx, input, found);
    expect(scope.history).toEqual({});
    const text = JSON.stringify([scope.history, buildDisplay(ctx, input)]);
    expect(text).not.toContain('Unproven scanner');
    expect(text).not.toContain('Unproven action');
    expect(text).not.toContain('"amount":49');
    expect(text).not.toContain('"after":56');
  });
});
