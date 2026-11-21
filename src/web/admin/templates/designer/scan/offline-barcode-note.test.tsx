import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import '../../../../lib/test-utils.tsx';
import { DesignerProvider } from '../context.tsx';
import { sampleDoc } from '../fixtures.ts';
import type { DesignDoc } from '../model.ts';
import { readBarcode, setBarcode } from '../ops-more.ts';
import { initialState } from '../reducer.ts';
import { OfflineBarcodeNote } from './offline-barcode-note.tsx';

const WARNING = "Member-number barcodes can't be checked offline.";

function show(doc: DesignDoc) {
  render(
    <DesignerProvider
      value={{
        doc,
        state: initialState(doc),
        edit: vi.fn(),
        select: vi.fn(),
        focusTarget: vi.fn(),
        dispatch: vi.fn(),
        assetBase: '',
        readOnly: false,
        stamps: { count: 0, setCount: vi.fn() },
      }}
    >
      <OfflineBarcodeNote />
    </DesignerProvider>,
  );
}

it('warns when the barcode message is not the scan code', () => {
  show(sampleDoc());
  expect(screen.getByText(WARNING)).toBeTruthy();
});

it('is silent when the barcode is the scan code, or there is no barcode', () => {
  const base = sampleDoc();
  const scan = setBarcode(base, { ...readBarcode(base), message: { kind: 'scanCode' } });
  show(scan);
  expect(screen.queryByText(WARNING)).toBeNull();
  show(setBarcode(base, { ...readBarcode(base), enabled: false }));
  expect(screen.queryByText(WARNING)).toBeNull();
});
