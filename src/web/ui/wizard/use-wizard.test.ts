import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/errors.ts';
import '../../lib/test-utils.tsx';
import { useWizard, type WizardOptions } from './use-wizard.ts';

type Id = 'a' | 'b' | 'c' | 'review';
const STEPS = [
  { id: 'a', title: 'A', heading: 'Do A' },
  { id: 'b', title: 'B', heading: 'Do B' },
  { id: 'c', title: 'C', heading: 'Do C' },
  { id: 'review', title: 'Review', heading: 'Check' },
] as const;

function setup(over: Partial<WizardOptions<Id>> = {}, start: Partial<Record<Id, boolean>> = {}) {
  const fail = { a: !start.a, b: !start.b, c: !start.c };
  return renderHook(
    (props: { bad: typeof fail }) =>
      useWizard<Id>({
        steps: STEPS,
        errors: {
          a: props.bad.a ? { name: 'Required.' } : undefined,
          b: props.bad.b ? { pick: 'Pick one.' } : undefined,
          c: props.bad.c ? { ips: 'Bad.' } : undefined,
        },
        hints: { a: 'Name it.' },
        fieldStep: { name: 'a', ips: 'c' },
        onFinish: () => undefined,
        ...over,
      }),
    { initialProps: { bad: fail } },
  );
}

const ok = { bad: { a: false, b: false, c: false } };
const submit = (w: { current: ReturnType<typeof useWizard<Id>> }) =>
  act(async () => {
    await w.current.form.onValid();
  });

describe('useWizard', () => {
  it('blocks a step with errors, hides them until a refused Next, then follows the value', () => {
    const { result, rerender } = setup();
    expect(result.current.blocked).toBe(true);
    expect(result.current.hint).toBe('Name it.');
    expect(result.current.errors).toEqual({});
    act(() => result.current.form.onInvalid());
    expect(result.current.errors).toEqual({ name: 'Required.' });
    rerender({ bad: { a: false, b: true, c: true } });
    expect(result.current.errors).toEqual({});
    expect(result.current.blocked).toBe(false);
  });

  it('falls back to the count when a step has no hint', async () => {
    const { result, rerender } = setup();
    rerender({ bad: { a: false, b: true, c: false } });
    await submit(result);
    expect(result.current.id).toBe('b');
    expect(result.current.hint).toBe('1 field needs attention');
  });

  it('keeps passed steps done and returns to Review once it was reached', async () => {
    const { result, rerender } = setup();
    rerender(ok);
    await submit(result);
    await submit(result);
    await submit(result);
    expect(result.current.id).toBe('review');
    expect(result.current.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'current']);
    act(() => result.current.go('a'));
    expect(result.current.id).toBe('a');
    expect(result.current.steps.map((s) => s.state)).toEqual(['current', 'done', 'done', 'todo']);
    expect(result.current.primary).toBe('review');
    await submit(result);
    expect(result.current.id).toBe('review');
  });

  it('says Next, not Review, the first time through', async () => {
    const { result, rerender } = setup();
    rerender(ok);
    expect(result.current.primary).toBe('next');
    await submit(result);
    await submit(result);
    expect(result.current.id).toBe('c');
    expect(result.current.primary).toBe('next');
  });

  it('goes only to steps that were passed, or behind', async () => {
    const { result, rerender } = setup();
    rerender(ok);
    act(() => result.current.go('c'));
    expect(result.current.id).toBe('a');
    await submit(result);
    act(() => result.current.go('a'));
    expect(result.current.id).toBe('a');
    act(() => result.current.back());
    expect(result.current.id).toBe('a');
  });

  it('hops skipped steps both ways', async () => {
    const { result, rerender } = setup({ steps: STEPS.map((s) => ({ ...s, skip: s.id === 'b' })) });
    rerender(ok);
    await submit(result);
    expect(result.current.id).toBe('c');
    expect(result.current.steps[1]?.state).toBe('skipped');
    act(() => result.current.back());
    expect(result.current.id).toBe('a');
  });

  it('jumps to the earliest step that owns a server field and marks it invalid', async () => {
    const onFinish = () => {
      throw new ApiError({
        status: 422,
        code: 'x',
        fields: { ips: 'Not allowed.', name: 'Taken.' },
      });
    };
    const { result, rerender } = setup({ onFinish });
    rerender(ok);
    await submit(result);
    await submit(result);
    await submit(result);
    let saved: unknown;
    await act(async () => {
      saved = await result.current.form.onValid();
    });
    expect(saved).toBe('refused');
    expect(result.current.id).toBe('a');
    expect(result.current.errors).toEqual({ ips: 'Not allowed.', name: 'Taken.' });
    expect(result.current.steps[2]?.state).toBe('invalid');
    act(() => result.current.clearServer('name'));
    expect(result.current.errors).toEqual({ ips: 'Not allowed.' });
    act(() => result.current.clearServer());
    expect(result.current.errors).toEqual({});
    expect(result.current.steps[2]?.state).toBe('done');
  });

  it('puts a field no step owns on the form line', async () => {
    const onFinish = () => {
      throw new ApiError({ status: 422, code: 'x', fields: { mode: 'Not allowed here.' } });
    };
    const { result, rerender } = setup({ onFinish });
    rerender(ok);
    await submit(result);
    await submit(result);
    await submit(result);
    await submit(result);
    expect(result.current.id).toBe('review');
    expect(result.current.formError).toBe('Not allowed here.');
  });

  it('shows a non-field error on the form line and clears it on the next move', async () => {
    const onFinish = () => {
      throw new ApiError({ status: 500, code: 'x', title: 'Boom' });
    };
    const { result, rerender } = setup({ onFinish });
    rerender(ok);
    await submit(result);
    await submit(result);
    await submit(result);
    await submit(result);
    expect(result.current.formError).toBeTruthy();
    act(() => result.current.back());
    expect(result.current.formError).toBeUndefined();
  });

  it('resets when the dialog closes', async () => {
    const { result, rerender } = renderHook(
      ({ open }) =>
        useWizard<Id>({
          steps: STEPS,
          errors: {},
          fieldStep: {},
          onFinish: () => undefined,
          open,
        }),
      { initialProps: { open: true } },
    );
    await act(async () => {
      await result.current.form.onValid();
    });
    expect(result.current.id).toBe('b');
    rerender({ open: false });
    expect(result.current.id).toBe('a');
    expect(result.current.steps[1]?.state).toBe('todo');
  });

  it('edit mode reaches every step, shows Save, and jumps to the earliest invalid step', async () => {
    const { result } = setup({ mode: 'edit' });
    expect(result.current.steps.map((s) => s.state)).toEqual([
      'current',
      'invalid',
      'invalid',
      'done',
    ]);
    expect(result.current.primary).toBe('finish');
    act(() => result.current.go('c'));
    expect(result.current.id).toBe('c');
    act(() => result.current.form.onInvalid());
    expect(result.current.id).toBe('a');
    expect(result.current.errors).toEqual({ name: 'Required.' });
  });
});
