import { describe, expect, it } from 'vitest';
import type { DesignDoc } from '../../admin/templates/designer/model.ts';
import { parseSample, sampleOf, sampleText } from './sample.ts';

const doc = (sample?: unknown): DesignDoc => ({
  passJson: {},
  manifest: sample === undefined ? {} : { sample },
  assets: [],
});

describe('sample', () => {
  it('reads the manifest sample, empty when there is none', () => {
    expect(sampleOf(doc({ name: 'Casey' }))).toEqual({ name: 'Casey' });
    expect(sampleOf(doc())).toEqual({});
    expect(sampleOf(doc([1]))).toEqual({});
  });
  it('prints it as indented JSON', () => {
    expect(sampleText(doc({ a: 1 }))).toBe('{\n  "a": 1\n}');
  });
  it('accepts an object and names the problem otherwise', () => {
    expect(parseSample('{"a":2}')).toEqual({ ok: true, sample: { a: 2 } });
    expect(parseSample('[1]')).toEqual({ ok: false, problem: 'The sample is an object.' });
    expect(parseSample('{"a"')).toEqual({ ok: false, problem: 'Not valid JSON yet.' });
  });
});
