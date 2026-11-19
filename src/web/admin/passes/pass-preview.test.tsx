import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePassView } from './pass-preview.tsx';

const pass = (extra: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  organizationName: 'Org',
  description: 'Membership',
  serialNumber: 's',
  passTypeIdentifier: 'pass.x',
  teamIdentifier: 'T',
  barcodes: [{ format: 'PKBarcodeFormatQR', message: 'abc', messageEncoding: 'iso-8859-1' }],
  generic: {
    headerFields: [{ key: 'status', label: 'Status', value: 'Active' }],
    primaryFields: [{ key: 'holder', label: 'Name', value: 'Maya' }],
  },
  ...extra,
});

const view = (json: Record<string, unknown>, removed = false) =>
  renderHook(() => usePassView(json, '/a', undefined, removed)).result.current;

describe('admin pass preview of an ended pass', () => {
  it('keeps the barcode and Active on a live pass', () => {
    const v = view(pass());
    expect(v?.layout.barcode).toBeDefined();
    expect(v?.layout.header[0]?.text).toBe('Active');
  });

  it('a voided pass shows Voided and no barcode, as the hosted page does', () => {
    const v = view(pass({ voided: true }));
    expect(v?.layout.barcode).toBeUndefined();
    expect(v?.layout.header[0]?.text).toBe('Voided');
  });

  it('a removed pass shows Removed and no barcode', () => {
    const v = view(pass(), true);
    expect(v?.layout.barcode).toBeUndefined();
    expect(v?.layout.header[0]?.text).toBe('Removed');
  });
});
