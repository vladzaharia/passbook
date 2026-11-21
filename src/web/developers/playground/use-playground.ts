import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PATHS } from '../../../shared/developers.ts';
import { loadSession } from '../console/session.ts';
import { decodeHash, encodeHash, type PlaygroundState } from './hash.ts';
import { type Built, type Connection, type Created, connect, type LiveClient } from './live.ts';
import { type BlueprintPreviews, DEFAULT_BLUEPRINT, type InputValues } from './model.ts';
import { editsOf, fromBlueprint, fromDetail, type PgTemplate, valuesOf } from './templates.ts';

/** The one thing kept in this browser: that the visitor chose their sandbox, so the next visit connects. */
const HINT = 'pb.developers.playground.live';
const DEBOUNCE_MS = 400;

const remembered = (): boolean => {
  try {
    return localStorage.getItem(HINT) === '1';
  } catch {
    // Storage blocked: the visitor presses the button each visit.
    return false;
  }
};
const remember = (on: boolean) => {
  try {
    if (on) localStorage.setItem(HINT, '1');
    else localStorage.removeItem(HINT);
  } catch {
    // Storage blocked: nothing to forget.
  }
};

export type Link =
  /** `signedIn`: a session exists, but the visitor has not chosen to edit in their sandbox yet. */
  | { kind: 'anonymous'; signedIn?: boolean }
  | { kind: 'connecting' }
  | { kind: 'no-sandbox' }
  | { kind: 'live'; client: LiveClient; orgSlug: string }
  | { kind: 'failed'; message: string };

export type Freshness = 'sample' | 'updating' | 'fresh' | 'error';

export function usePlayground(data: BlueprintPreviews) {
  const blueprints = useMemo(() => data.items.map(fromBlueprint), [data]);
  const [state, setState] = useState<PlaygroundState>(() =>
    decodeHash(location.hash, DEFAULT_BLUEPRINT),
  );
  // A link that names a template keeps it; one that does not opens on the visitor's own once connected.
  const named = useRef(new URLSearchParams(location.hash.replace(/^#/, '')).has('t'));
  const [link, setLink] = useState<Link>({ kind: 'anonymous' });
  const [own, setOwn] = useState<PgTemplate | null>(null);
  const [built, setBuilt] = useState<{ templateId: string; key: string; built: Built } | null>(
    null,
  );
  const [freshness, setFreshness] = useState<Freshness>('sample');
  const [updatedAt, setUpdatedAt] = useState(0);
  const [created, setCreated] = useState<Created | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The hash is the state: every change writes it, and a pasted link or Back reads it.
  useEffect(() => {
    const next = encodeHash(state);
    if (next !== location.hash) history.replaceState(null, '', next);
  }, [state]);
  useEffect(() => {
    const onHash = () => setState(decodeHash(location.hash, DEFAULT_BLUEPRINT));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const templates = useMemo(() => (own ? [own, ...blueprints] : blueprints), [own, blueprints]);
  const template =
    templates.find((t) => t.id === state.template) ??
    blueprints.find((t) => t.id === DEFAULT_BLUEPRINT) ??
    (blueprints[0] as PgTemplate);
  const values = useMemo(() => valuesOf(template, state.edits), [template, state.edits]);
  const live = link.kind === 'live' ? link.client : null;

  const patch = useCallback(
    (next: Partial<PlaygroundState>) => setState((s) => ({ ...s, ...next })),
    [],
  );
  const setValues = useCallback(
    (next: InputValues) => patch({ edits: editsOf(template, next) }),
    [patch, template],
  );
  const pick = useCallback(
    (id: string) => {
      named.current = true;
      setCreated(null);
      setProblem(null);
      patch({ template: id, edits: {} });
    },
    [patch],
  );

  // Connecting is the visitor's choice (the button), or what they chose last time.
  const attach = useCallback(
    async (redirect: boolean) => {
      setLink({ kind: 'connecting' });
      try {
        const c: Connection = await connect();
        if (c.state === 'signed-out') {
          remember(false);
          if (!redirect) return setLink({ kind: 'anonymous' });
          remember(true);
          return void location.assign(`/login?next=${encodeURIComponent(PATHS.playground)}`);
        }
        remember(true);
        if (c.state === 'no-sandbox') return setLink({ kind: 'no-sandbox' });
        const id = c.client.sandbox.templateId;
        if (id) {
          const mine = fromDetail(await c.client.template(id));
          setOwn(mine);
          if (!named.current) patch({ template: mine.id, edits: {} });
        }
        setLink({ kind: 'live', client: c.client, orgSlug: c.client.sandbox.orgSlug });
      } catch (e) {
        setLink({
          kind: 'failed',
          message: e instanceof Error ? e.message : 'Could not reach your sandbox.',
        });
      }
    },
    [patch],
  );
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // A link to your own template cannot open anonymously; the hint is the one thing that connects unasked.
    if (remembered()) void attach(false);
    void loadSession().then((session) => {
      if (session.kind !== 'out')
        setLink((l) => (l.kind === 'anonymous' ? { ...l, signedIn: true } : l));
    });
  }, [attach]);

  // Live: every pause in editing renders the real pass.json. Anonymous: the starter's own sample.
  const editKey = JSON.stringify([template.id, state.edits]);
  useEffect(() => {
    if (!live) {
      setFreshness('sample');
      return;
    }
    const controller = new AbortController();
    setFreshness('updating');
    const timer = setTimeout(() => {
      live.preview(template.id, values, controller.signal).then(
        (result) => {
          setBuilt({ templateId: template.id, key: editKey, built: result });
          setFreshness('fresh');
          setUpdatedAt(Date.now());
          setProblem(null);
        },
        (e: unknown) => {
          if (controller.signal.aborted) return;
          setFreshness('error');
          setProblem(e instanceof Error ? e.message : 'Could not render. Try again.');
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [live, template.id, values, editKey]);

  // While a new render is on its way the last one of this template stays up, so the cards never flash empty.
  const current: Built | null =
    (live && built?.templateId === template.id ? built.built : null) ??
    template.fixed?.built ??
    null;

  const create = useCallback(async () => {
    if (!live || !template.issuable) return;
    setProblem(null);
    try {
      setCreated(await live.create(template.id, values));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not create the pass. Try again.');
    }
  }, [live, template, values]);

  return {
    state,
    patch,
    templates,
    template,
    values,
    setValues,
    pick,
    link,
    attach,
    built: current,
    freshness,
    updatedAt,
    created,
    create,
    problem,
  };
}
