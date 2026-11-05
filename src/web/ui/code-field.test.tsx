import { fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CODE_LENGTH, CodeField, codeDigits, crockfordCode } from './code-field.tsx';

function Harness({
  length,
  group,
  alphabet,
}: {
  length?: number;
  group?: number;
  alphabet?: 'digits' | 'crockford';
}) {
  const [v, setV] = useState('');
  return (
    <CodeField id="c" value={v} onChange={setV} length={length} group={group} alphabet={alphabet} />
  );
}

describe('code normalisation', () => {
  it('keeps six digits by default', () => {
    expect(CODE_LENGTH).toBe(6);
    expect(codeDigits('123 456 789')).toBe('123456');
  });
  it('normalises Crockford: case, separators, I/L to 1, O to 0, no U', () => {
    expect(crockfordCode('k7qh2-m9xtr', 10)).toBe('K7QH2M9XTR');
    expect(crockfordCode('iL oO', 10)).toBe('1100');
    expect(crockfordCode('U7U', 10)).toBe('7');
    expect(crockfordCode('K7QH2M9XTRZZ', 10)).toBe('K7QH2M9XTR');
  });
});

describe('CodeField', () => {
  it('groups six digits 3 and 3 by default', () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('.wl-code-slot')).toHaveLength(6);
    expect(container.querySelectorAll('[data-group-start]')).toHaveLength(1);
    expect(container.querySelector('[data-group-start]')).toBe(
      container.querySelectorAll('.wl-code-slot')[3],
    );
  });
  it('groups ten Crockford characters 5 and 5 and normalises typing', () => {
    const { container } = render(<Harness length={10} group={5} alphabet="crockford" />);
    const slots = container.querySelectorAll('.wl-code-slot');
    expect(slots).toHaveLength(10);
    expect(container.querySelector('[data-group-start]')).toBe(slots[5]);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'k7qh2-m9xtr' } });
    expect(input.value).toBe('K7QH2M9XTR');
    expect(container.querySelector('.wl-code')).toHaveAttribute('data-complete');
    expect(input).toHaveAttribute('inputmode', 'text');
    expect(input).toHaveAttribute('autocapitalize', 'characters');
  });
  it('digit fields stay numeric', () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('input')).toHaveAttribute('inputmode', 'numeric');
  });
});
