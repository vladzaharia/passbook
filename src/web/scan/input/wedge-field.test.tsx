import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScanTextField, WedgeFieldsContext } from './wedge-field.tsx';
import { WedgeFields } from './wedge-source.ts';

function Harness({ fields }: { fields: WedgeFields }) {
  return (
    <WedgeFieldsContext.Provider value={fields}>
      <ScanTextField aria-label="Name, email or code" value="x" onChange={() => {}} />
    </WedgeFieldsContext.Provider>
  );
}

describe('ScanTextField', () => {
  it('registers its input with a setter that restores the value, and unregisters on unmount', () => {
    const fields = new WedgeFields();
    const changes: string[] = [];
    const { unmount } = render(
      <WedgeFieldsContext.Provider value={fields}>
        <ScanTextField
          aria-label="Code"
          value="x"
          onChange={() => {}}
          onValueRestore={(v) => changes.push(v)}
        />
      </WedgeFieldsContext.Provider>,
    );
    const input = screen.getByLabelText('Code');
    expect(fields.has(input)).toBe(true);
    fields.restore(input, 'ab');
    expect(changes).toEqual(['ab']);
    unmount();
    expect(fields.has(input)).toBe(false);
  });

  it('is a registered, inputmode-free text field by default', () => {
    const fields = new WedgeFields();
    render(<Harness fields={fields} />);
    expect(fields.has(screen.getByLabelText('Name, email or code'))).toBe(true);
  });
});

/** Every input and textarea in the scan app must be a registered wedge field (AC 2.4). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

describe('guard: scan fields', () => {
  it('no raw <input>, <textarea> or kit Input/Textarea outside ScanTextField', () => {
    const root = join(import.meta.dirname, '..');
    const offenders = sources(root)
      .filter((file) => !file.endsWith(join('input', 'wedge-field.tsx')))
      .filter((file) => /<(input|textarea|Input|Textarea)[\s/>]/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });
});
