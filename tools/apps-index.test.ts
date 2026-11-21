import { describe, expect, it } from 'vitest';
import { buildIndex, fdroidLinks, normalizeFingerprint, scalable } from './apps-index.ts';

const fp = 'AB'.repeat(32);
const base = {
  pagesUrl: 'https://vladzaharia.github.io/passbook',
  fingerprint: fp,
  qrSvg: '<svg viewBox="0 0 1 1"></svg>',
  iconSvg: '<svg viewBox="0 0 32 32"></svg>',
};

describe('install page', () => {
  it('links the source and repo deep links', () => {
    const html = buildIndex(base);
    expect(html).toContain(
      'altstore://source?url=https://vladzaharia.github.io/passbook/altstore/source.json',
    );
    expect(html).toContain(
      'sidestore://source?url=https://vladzaharia.github.io/passbook/altstore/source.json',
    );
    expect(html).toContain(
      `fdroidrepos://vladzaharia.github.io/passbook/fdroid/repo?fingerprint=${fp}`,
    );
    expect(html).toContain('obtainium://add/https://github.com/vladzaharia/passbook');
    expect(html).toContain('<svg viewBox="0 0 1 1">');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  it('hides TestFlight and Play until there are https URLs', () => {
    const none = buildIndex({ ...base, testflightUrl: '', playUrl: 'not a url' });
    expect(none).not.toContain('id="testflight"');
    expect(none).not.toContain('id="play"');
    const both = buildIndex({
      ...base,
      testflightUrl: 'https://testflight.apple.com/join/abc',
      playUrl: 'https://play.google.com/apps/internaltest/1',
    });
    expect(both).toContain('href="https://testflight.apple.com/join/abc"');
    expect(both).toContain('id="play"');
  });

  it('accepts a colon fingerprint and rejects a bad one', () => {
    expect(normalizeFingerprint(fp.match(/.{2}/g)?.join(':').toLowerCase() ?? '')).toBe(fp);
    expect(() => normalizeFingerprint('abc')).toThrow(/SHA-256/);
    expect(fdroidLinks('https://x.example/p', fp).web).toBe(
      `https://x.example/p/fdroid/repo?fingerprint=${fp}`,
    );
  });

  it('adds a viewBox to a QR without one', () => {
    expect(scalable('<svg xmlns="x" width="148" height="148"><path/></svg>')).toContain(
      'viewBox="0 0 148 148"',
    );
    expect(scalable('<svg viewBox="0 0 1 1" width="5"></svg>')).toBe(
      '<svg viewBox="0 0 1 1" width="5"></svg>',
    );
  });

  it('refuses a QR that is not an SVG', () => {
    expect(() => buildIndex({ ...base, qrSvg: '<script>x</script>' })).toThrow(/SVG/);
  });
});
