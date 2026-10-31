import { describe, expect, it } from 'vitest';
import { autolink, parseAttributed, safeHref } from './sanitize.ts';

describe('safeHref', () => {
  it.each([
    ['https://example.com/a?b=1', 'https://example.com/a?b=1'],
    ['tel:+15550100', 'tel:+15550100'],
    ['mailto:a@example.com', 'mailto:a@example.com'],
  ])('allows %s', (input, out) => expect(safeHref(input)).toBe(out));

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    ' \u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://example.com',
    'https://user:pw@example.com',
    'https://',
    '//example.com',
    'vbscript:x',
    'mailto:',
    'tel:1"onclick="x',
  ])('rejects %j', (input) => expect(safeHref(input)).toBeUndefined());
});

describe('parseAttributed', () => {
  it('keeps safe anchors as data', () => {
    expect(parseAttributed('Visit <a href="https://example.com">us</a> now')).toEqual([
      { text: 'Visit ' },
      { text: 'us', href: 'https://example.com/' },
      { text: ' now' },
    ]);
  });

  it('accepts single-quoted, unquoted and tel/mailto hrefs', () => {
    const out = parseAttributed(
      '<a href=\'tel:+1555\'>a</a> <a href=mailto:x@y.co>b</a> <a HREF="https://x.io">c</a>',
    );
    expect(out.filter((s) => s.href).map((s) => s.href)).toEqual([
      'tel:+1555',
      'mailto:x@y.co',
      'https://x.io/',
    ]);
  });

  it.each([
    '<a href="javascript:alert(1)">x</a>',
    '<a href="  javascript:alert(1)">x</a>',
    '<a href="java&#115;cript:alert(1)">x</a>',
    '<a href="&#x6A;avascript:alert(1)">x</a>',
    '<a href="data:text/html;base64,AAAA">x</a>',
    '<a onclick="alert(1)" href="javascript:1">x</a>',
    '<a>x</a>',
  ])('drops the link but keeps the text for %s', (input) => {
    expect(parseAttributed(input)).toEqual([{ text: 'x' }]);
  });

  it('strips other tags and script content', () => {
    expect(
      parseAttributed('a<script>alert(1)</script>b<img src=x onerror=alert(1)>c<b>d</b>'),
    ).toEqual([{ text: 'abcd' }]);
    expect(parseAttributed('<style>body{}</style>ok')).toEqual([{ text: 'ok' }]);
  });

  it('never emits markup characters from tags, only decoded text', () => {
    const out = parseAttributed(
      '&lt;script&gt;alert(1)&lt;/script&gt; <a href="https://a.io">&amp;</a>',
    );
    expect(out).toEqual([
      { text: '<script>alert(1)</script> ' },
      { text: '&', href: 'https://a.io/' },
    ]);
  });

  it('leaves an unterminated tag as inert text', () => {
    expect(parseAttributed('x <a href="https://a.io"')).toEqual([
      { text: 'x <a href="https://a.io"' },
    ]);
  });

  it('does not decode entities twice', () => {
    expect(parseAttributed('&amp;lt;')).toEqual([{ text: '&lt;' }]);
  });

  it('ignores invalid code points', () => {
    expect(parseAttributed('&#0;&#xD800;&#99999999;')).toEqual([
      { text: '&#0;&#xD800;&#99999999;' },
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(parseAttributed('')).toEqual([]);
  });
});

describe('autolink', () => {
  const all = new Set(['link', 'phone'] as const);

  it('links urls, emails and phones', () => {
    const out = autolink('Go https://a.io/x, mail me@a.io or call +1 (555) 010-9999.', all);
    expect(out.filter((s) => s.href)).toEqual([
      { text: 'https://a.io/x', href: 'https://a.io/x' },
      { text: 'me@a.io', href: 'mailto:me@a.io' },
      { text: '+1 (555) 010-9999', href: 'tel:+15550109999' },
    ]);
    expect(out.map((s) => s.text).join('')).toBe(
      'Go https://a.io/x, mail me@a.io or call +1 (555) 010-9999.',
    );
  });

  it('does not treat dates or short numbers as phones', () => {
    expect(autolink('2026-10-31 and 12345', all)).toEqual([{ text: '2026-10-31 and 12345' }]);
  });

  it('does not link plain http', () => {
    expect(autolink('http://a.io', all)).toEqual([{ text: 'http://a.io' }]);
  });

  it('honours the detector set', () => {
    expect(autolink('https://a.io', new Set())).toEqual([{ text: 'https://a.io' }]);
    expect(autolink('https://a.io 555 010 9999', new Set(['phone'] as const))).toEqual([
      { text: 'https://a.io ' },
      { text: '555 010 9999', href: 'tel:5550109999' },
    ]);
  });
});
