import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  decodeHash,
  encodeHash,
  type InputMode,
  type PlaygroundState,
} from '../../playground/hash.ts';
import {
  type BlueprintPreviews,
  DEFAULT_BLUEPRINT,
  type InputValues,
} from '../../playground/model.ts';
import { editsOf, valuesOf } from '../../playground/templates.ts';
import { type AnonBlueprint, anonBlueprint } from './blueprint.ts';

/** The page's state is kept here as well as in the hash, so a sign-in that drops the hash loses nothing. */
const MIRROR = 'wb-anon-design';

export function readMirror(): PlaygroundState | null {
  try {
    const raw = sessionStorage.getItem(MIRROR);
    return raw ? decodeHash(raw, DEFAULT_BLUEPRINT) : null;
  } catch {
    // Storage blocked: the hash alone carries the state.
    return null;
  }
}

export function writeMirror(state: PlaygroundState): void {
  try {
    sessionStorage.setItem(MIRROR, encodeHash(state));
  } catch {
    // Storage blocked: the hash alone carries the state.
  }
}

export function clearMirror(): void {
  try {
    sessionStorage.removeItem(MIRROR);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/** The state a visit opens on: its hash, else what this tab last kept. */
export function openingState(hash: string): PlaygroundState {
  const named = new URLSearchParams(hash.replace(/^#/, '')).has('t');
  return named
    ? decodeHash(hash, DEFAULT_BLUEPRINT)
    : (readMirror() ?? decodeHash('', DEFAULT_BLUEPRINT));
}

export function useAnonState(data: BlueprintPreviews) {
  const blueprints = useMemo(() => data.items.map(anonBlueprint), [data]);
  const [state, setState] = useState<PlaygroundState>(() => openingState(location.hash));
  useEffect(() => {
    const next = encodeHash(state);
    if (next !== location.hash) history.replaceState(null, '', next);
    writeMirror(state);
  }, [state]);
  useEffect(() => {
    const onHash = () => setState(openingState(location.hash));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const fallback = blueprints.find((b) => b.preview.id === DEFAULT_BLUEPRINT) ?? blueprints[0];
  const found = blueprints.find((b) => b.preview.id === state.template);
  const current = (found ?? fallback) as AnonBlueprint;
  const values = useMemo(() => valuesOf(current.pg, state.edits), [current, state.edits]);
  const setValues = useCallback(
    (next: InputValues) => setState((s) => ({ ...s, edits: editsOf(current.pg, next) })),
    [current],
  );
  const pick = useCallback(
    (id: string) => setState((s) => ({ ...s, template: id, edits: {} })),
    [],
  );
  const setMode = useCallback((mode: InputMode) => setState((s) => ({ ...s, mode })), []);
  return {
    blueprints,
    current,
    /** A link named a blueprint that is not offered: the page shows another and says so. */
    missing: !found && state.template !== DEFAULT_BLUEPRINT ? current.preview.name : null,
    state,
    values,
    setValues,
    pick,
    setMode,
  };
}
