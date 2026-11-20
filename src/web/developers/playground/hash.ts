import type { InputValues } from './model.ts';

export const CHANNELS = ['all', 'apple', 'google', 'samsung', 'paper'] as const;
export const FACES = ['front', 'back'] as const;
export const LANGS = ['ts', 'curl', 'py', 'go'] as const;
export const MODES = ['form', 'json'] as const;

export type Channel = (typeof CHANNELS)[number];
export type Face = (typeof FACES)[number];
export type CodeLang = (typeof LANGS)[number];
export type InputMode = (typeof MODES)[number];

/** Everything the page shows, so a link shares the exact pass. */
export interface PlaygroundState {
  template: string;
  /** Only what differs from the template's sample: short links, and "was 120" for free. */
  edits: InputValues;
  channel: Channel;
  face: Face;
  lang: CodeLang;
  mode: InputMode;
}

export const DEFAULTS = {
  channel: 'all',
  face: 'front',
  lang: 'ts',
  mode: 'form',
} as const satisfies Omit<PlaygroundState, 'template' | 'edits'>;

/** Longer than this is not a link a person made. */
const MAX_HASH = 12_000;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
const b64ToBytes = (text: string): Uint8Array => {
  const bin = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export const encodeEdits = (edits: InputValues): string =>
  bytesToB64(new TextEncoder().encode(JSON.stringify(edits)));

function decodeEdits(text: string): InputValues {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(b64ToBytes(text)));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: InputValues = {};
    for (const [key, value] of Object.entries(parsed)) if (!FORBIDDEN.has(key)) out[key] = value;
    return out;
  } catch {
    // A link someone mangled: show the template's own sample.
    return {};
  }
}

const pick = <T extends string>(list: readonly T[], value: string | null, fallback: T): T =>
  list.find((x) => x === value) ?? fallback;

/** `#t=<template>&c=&f=&l=&m=&i=<edits>`; a value that is the default is left out. */
export function encodeHash(state: PlaygroundState): string {
  const params = new URLSearchParams();
  params.set('t', state.template);
  for (const key of ['channel', 'face', 'lang', 'mode'] as const) {
    if (state[key] !== DEFAULTS[key]) params.set(key[0] as string, state[key]);
  }
  if (Object.keys(state.edits).length > 0) params.set('i', encodeEdits(state.edits));
  return `#${params.toString()}`;
}

/** Reads a hash; anything missing or not understood falls back, so any link opens. */
export function decodeHash(hash: string, fallbackTemplate: string): PlaygroundState {
  const params = new URLSearchParams(hash.length > MAX_HASH ? '' : hash.replace(/^#/, ''));
  const t = params.get('t');
  return {
    template: t && t.length <= 200 ? t : fallbackTemplate,
    edits: decodeEdits(params.get('i') ?? ''),
    channel: pick(CHANNELS, params.get('c'), DEFAULTS.channel),
    face: pick(FACES, params.get('f'), DEFAULTS.face),
    lang: pick(LANGS, params.get('l'), DEFAULTS.lang),
    mode: pick(MODES, params.get('m'), DEFAULTS.mode),
  };
}
