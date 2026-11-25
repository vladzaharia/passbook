import { Hash, Lock, RotateCw } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { SEARCH_COPY } from '../../../shared/copy/developers-search.ts';
import { PATHS } from '../../../shared/developers.ts';
import { classify } from '../../../shared/developers-search.ts';
import { CommandPalette } from '../../ui/command-palette.tsx';
import { actionItem, groupsOf, guideItem, item } from './items.tsx';
import { type Lookup, loadIndex, reportMiss, resolveId } from './net.ts';
import { Preview } from './preview.tsx';
import { hintFor, isEmpty, narrow, type Results, search, wordsOf } from './rank.ts';
import type { SearchIndex } from './types.ts';

const C = SEARCH_COPY;
/** A search that found nothing counts as a miss once the reader has stopped typing. */
const SETTLE_MS = 700;
/** The list is ranked again this long after the last key. Until then it only loses rows. */
const RANK_MS = 150;
const SIGN_IN = '/login?next=%2Fdevelopers';

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; index: SearchIndex };

function useIndex(open: boolean): Load {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    if (!open) return;
    let live = true;
    loadIndex().then(
      (index) => live && setLoad({ state: 'ready', index }),
      () => live && setLoad({ state: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [open]);
  return load;
}

/** A pasted id, looked up in the signed-in person's sandbox. Keyed by id, so a late answer never lands on another one. */
function useLookup(id: string | null): Lookup | 'looking' | null {
  const [seen, setSeen] = useState<{ id: string; lookup: Lookup } | null>(null);
  useEffect(() => {
    if (!id) return;
    const abort = new AbortController();
    resolveId(id, abort.signal).then(
      (lookup) => setSeen({ id, lookup }),
      () => {
        // Aborted: a newer query owns the answer.
      },
    );
    return () => abort.abort();
  }, [id]);
  if (!id) return null;
  return seen?.id === id ? seen.lookup : 'looking';
}

/**
 * The ranked rows for the query. While keys are still going in the list is only narrowed, so no row
 * changes place under the reader; once they pause for RANK_MS it is ranked afresh. The first key
 * after an empty box, and a narrowing that leaves nothing, rank at once.
 */
function useResults(index: SearchIndex | null, query: string, secret: boolean): Results | null {
  const ranked = useRef<{ query: string; results: Results } | null>(null);
  const [, ranAgain] = useReducer((n: number) => n + 1, 0);
  const q = query.trim();
  let results: Results | null = null;
  if (index && !secret) {
    const base = ranked.current;
    const narrowed = base && base.query !== '' && q !== '' ? narrow(base.results, q) : null;
    if (base?.query === q) results = base.results;
    else if (narrowed && !isEmpty(narrowed)) results = narrowed;
    else {
      results = search(index, q);
      ranked.current = { query: q, results };
    }
  }
  useEffect(() => {
    if (!index || secret || ranked.current?.query === q) return;
    const timer = setTimeout(() => {
      ranked.current = { query: q, results: search(index, q) };
      ranAgain();
    }, RANK_MS);
    return () => clearTimeout(timer);
  }, [index, secret, q]);
  return results;
}

/** A signing secret is rolled on the webhook endpoint, an API key on the keys page. */
const SIGNING_HELP = ['ref:webhook-endpoints', 'test-webhook'];
const WEBHOOK_ENDPOINTS = `${PATHS.reference}/webhook-endpoints`;

function SecretCard({
  tail,
  signing,
  onClear,
}: {
  tail: string;
  signing: boolean;
  onClear: () => void;
}) {
  return (
    <div className="srch-secret" role="alert">
      <div className="srch-secret-h">
        <Lock aria-hidden />
        <span className="strong">{signing ? C.secret.signingTitle : C.secret.title}</span>
      </div>
      <p className="sm">{signing ? C.secret.signingBody : C.secret.body}</p>
      <div className="srch-actions">
        <a className="btn sm" href={signing ? WEBHOOK_ENDPOINTS : '/admin/api-keys'}>
          <RotateCw aria-hidden />
          {signing ? C.secret.rotate : C.secret.roll} …{tail}
        </a>
        <button type="button" className="btn outline sm" onClick={onClear}>
          {C.secret.clear}
        </button>
      </div>
    </div>
  );
}

function Status({ children }: { children: ReactNode }) {
  return (
    <p className="srch-status sm" role="status">
      {children}
    </p>
  );
}

function IdStatus({ lookup }: { lookup: Lookup | 'looking' | null }) {
  if (lookup === 'looking') return <Status>{C.id.looking}</Status>;
  if (lookup === null || lookup.state === 'found') return null;
  if (lookup.state === 'signed-out')
    return (
      <Status>
        {C.id.signIn}{' '}
        <a className="srch-link" href={SIGN_IN}>
          {C.id.signInAction}
        </a>
      </Status>
    );
  return <Status>{lookup.state === 'none' ? C.id.none : C.id.failed}</Status>;
}

export function SearchPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const load = useIndex(open);
  const index = load.state === 'ready' ? load.index : null;
  const pasted = useMemo(() => classify(query), [query]);
  const lookup = useLookup(open && pasted.kind === 'id' ? pasted.id : null);
  const words = useMemo(() => (pasted.kind === 'secret' ? [] : wordsOf(query)), [pasted, query]);
  const results = useResults(index, query, pasted.kind === 'secret');

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // A miss is reported once the reader stops typing, and only for plain words (never a secret).
  const nothing = results !== null && isEmpty(results);
  useEffect(() => {
    if (!open || !nothing || !query.trim()) return;
    if (pasted.kind !== 'text' && pasted.kind !== 'route') return;
    const timer = setTimeout(() => reportMiss(query), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [open, nothing, query, pasted.kind]);

  const found =
    lookup && lookup !== 'looking' && lookup.state === 'found'
      ? [
          item(`found:${lookup.found.kind}`, lookup.found.label, lookup.found.href, {
            icon: Hash,
            hint: C.id[lookup.found.kind],
          }),
        ]
      : [];
  const helpIds = pasted.kind === 'secret' && pasted.signing ? SIGNING_HELP : index?.secretHelp;
  const also =
    index && helpIds
      ? [
          ...index.guides.filter((g) => helpIds.includes(g.id)).map((g) => guideItem(g, [])),
          ...index.actions.filter((a) => helpIds.includes(a.id)).map((a) => actionItem(a, [])),
        ]
      : [];

  const groups =
    pasted.kind === 'secret'
      ? [{ heading: C.groups.also, items: also }]
      : [
          ...(pasted.kind === 'id' ? [{ heading: C.groups.open, items: found }] : []),
          ...(results ? groupsOf(results, words) : []),
        ];
  const hint = index && results && isEmpty(results) ? hintFor(index, query) : null;
  const quiet = !index || pasted.kind === 'id' || pasted.kind === 'secret';

  const banner =
    pasted.kind === 'secret' ? (
      <SecretCard tail={pasted.tail} signing={pasted.signing} onClear={() => setQuery('')} />
    ) : pasted.kind === 'id' ? (
      <IdStatus lookup={lookup} />
    ) : load.state === 'failed' ? (
      <Status>{C.failed}</Status>
    ) : load.state === 'loading' && query.trim() ? (
      <Status>{C.loading}</Status>
    ) : null;

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      query={query}
      onQueryChange={setQuery}
      placeholder={C.placeholder}
      banner={banner}
      hint={C.hints.footer}
      emptyLabel={quiet ? null : C.empty(query.trim())}
      empty={
        index && results && isEmpty(results) && !quiet ? (
          <div className="srch-empty">
            {hint ? (
              <>
                <p className="sm muted">{hint.text}</p>
                <div className="srch-pills">
                  {hint.links.map((l) => (
                    <a key={l.href} className="pill neutral" href={l.href}>
                      {l.label}
                    </a>
                  ))}
                </div>
              </>
            ) : null}
            <div className="srch-pills">
              <span className="sm muted">{GATE_COPY.search.try}</span>
              {GATE_COPY.search.suggestions.map((term) => (
                <button
                  key={term}
                  type="button"
                  className="pill neutral mono"
                  onClick={() => setQuery(term)}
                >
                  {term}
                </button>
              ))}
            </div>
          </div>
        ) : null
      }
      preview={(id) =>
        index && pasted.kind !== 'secret' && !id.startsWith('found:') ? (
          <Preview id={id} index={index} />
        ) : null
      }
      inputAttributes={{
        spellCheck: false,
        autoComplete: 'off',
        autoCorrect: 'off',
        autoCapitalize: 'off',
      }}
    />
  );
}
