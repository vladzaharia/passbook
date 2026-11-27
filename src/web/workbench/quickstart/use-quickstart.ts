import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import type { DeveloperProgress } from '../../../shared/contracts/developer-home.ts';
import { type Sandbox, type Session, updateSession } from '../console/session.ts';
import { type Built, LiveClient, LiveError, PORTAL_READ } from '../playground/live.ts';
import type { InputValues } from '../playground/model.ts';
import { fromDetail, type PgTemplate } from '../playground/templates.ts';
import { beacon } from './beacon.ts';
import { firstInput, type Problem } from './model.ts';
import { useTransport } from './transport.tsx';
import type { Call, QsPass } from './types.ts';
import { useHome } from './use-home.ts';
import { markViewed } from './viewed.ts';

interface PassBody {
  id: string;
  version: number;
  downloadUrl: string;
  passJson: Record<string, unknown>;
  assetBaseUrl: string;
  assetNames: string[];
  personalization: InputValues;
}

const passOf = (body: PassBody, startedAt: number): QsPass => ({
  id: body.id,
  version: body.version,
  previewUrl: body.downloadUrl,
  built: {
    passJson: body.passJson,
    assetBaseUrl: body.assetBaseUrl,
    assetNames: body.assetNames,
  } satisfies Built,
  input: body.personalization,
  startedAt,
});

const problemOf = (e: unknown): Problem =>
  e instanceof LiveError
    ? { status: e.status, code: e.code, detail: e.message }
    : { status: 0, code: undefined, detail: '' };

/**
 * The quickstart's state: who is looking, the sandbox's template, and the two calls it makes (create, change). The key
 * of a sandbox made on this page stays here, in memory, for the .env step; it is never stored.
 */
export function useQuickstart(initial: Session, onContexts?: () => void) {
  const viewedAt = useRef(markViewed()).current;
  const session = initial;
  const [secret, setSecret] = useState<string | null>(null);
  const [made, setMade] = useState<Sandbox | null>(null);
  const [template, setTemplate] = useState<PgTemplate | null>(null);
  const [run, setRun] = useState<Call>({ state: 'idle' });
  const [change, setChange] = useState<Call>({ state: 'idle' });
  const [pass, setPass] = useState<QsPass | null>(null);
  const [renderedMs, setRenderedMs] = useState<number | null>(null);
  const [renderedAt, setRenderedAt] = useState<number | null>(null);
  /** Same key for "Run again" (the pass comes back as it was); a failed run starts a new one. */
  const key = useRef(crypto.randomUUID());

  const csrf = session.kind === 'out' ? '' : session.csrf;
  const sandbox = made ?? (session.kind === 'ready' ? session.sandbox : null);
  const transport = useTransport(sandbox?.orgId ?? null, csrf);
  const { home, skew, refresh } = useHome();
  const progress: DeveloperProgress | null = home?.progress ?? null;
  const client = useMemo(
    () =>
      sandbox
        ? new LiveClient(
            csrf,
            { templateId: sandbox.templateId, orgSlug: sandbox.orgSlug },
            transport.token ?? undefined,
          )
        : null,
    [csrf, sandbox, transport],
  );
  const templateId = sandbox?.templateId ?? null;

  useEffect(() => {
    if (!client || !templateId) return;
    let live = true;
    client.template(templateId).then(
      (t) => live && setTemplate(fromDetail(t)),
      // No template to read: step 3 says so, with the way to finish the setup.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, templateId]);

  // A person who already has a sandbox opens the page for the first time here; the server stamps it once.
  const told = useRef(false);
  useEffect(() => {
    if (session.kind !== 'ready' || told.current) return;
    told.current = true;
    beacon(session.csrf, 'view');
  }, [session]);

  const input = useMemo(() => (template ? firstInput(template.sample) : null), [template]);

  const sandboxMade = useCallback(
    (s: Sandbox, key_: string | null) => {
      setMade(s);
      // A new key means the held token belongs to the old one; the nav and switcher read the sandbox again.
      transport.forget();
      onContexts?.();
      if (csrf)
        updateSession({
          kind: 'ready',
          csrf,
          sandbox: s,
          siteKey: session.kind === 'none' || session.kind === 'ready' ? session.siteKey : '',
        });
      if (key_) setSecret(key_);
      setRun({ state: 'idle' });
      if (csrf) beacon(csrf, 'sandbox');
      void refresh();
    },
    [csrf, session, refresh, transport, onContexts],
  );

  const create = useCallback(async () => {
    if (!client || !templateId || !input) return;
    setRun({ state: 'running', startedAt: Date.now() });
    const t0 = performance.now();
    try {
      const sent = await client.send<PassBody>(
        'POST',
        '/passes',
        { templateId, input },
        { 'Idempotency-Key': key.current },
      );
      if (sent.ok && sent.body) {
        setPass(passOf(sent.body, t0));
        setRun({
          state: 'ok',
          status: sent.status,
          ms: sent.ms,
          requestId: sent.requestId,
          replayed: sent.replayed,
          at: Date.now(),
        });
        beacon(csrf, 'run');
        void refresh();
        return;
      }
      key.current = crypto.randomUUID();
      const problem = {
        status: sent.status,
        code: sent.problem?.code,
        detail: sent.problem?.detail ?? '',
      };
      setRun({ state: 'fail', problem, requestId: sent.requestId, at: Date.now() });
      beacon(csrf, 'fail', problem.code);
    } catch (e) {
      key.current = crypto.randomUUID();
      setRun({ state: 'fail', problem: problemOf(e), requestId: null, at: Date.now() });
      beacon(csrf, 'fail', 'NETWORK');
    }
  }, [client, templateId, input, csrf, refresh]);

  const update = useCallback(
    async (admission: string) => {
      if (!client || !pass) return;
      setChange({ state: 'running', startedAt: Date.now() });
      const t0 = performance.now();
      try {
        const sent = await client.send<PassBody>(
          'PATCH',
          `/passes/${encodeURIComponent(pass.id)}`,
          { input: { admission }, notify: true },
          { 'If-Match': `"${pass.version}"` },
        );
        if (sent.ok && sent.body) {
          setPass(passOf(sent.body, t0));
          setChange({
            state: 'ok',
            status: sent.status,
            ms: sent.ms,
            requestId: sent.requestId,
            replayed: false,
            at: Date.now(),
            etag: sent.etag,
            via: 'here',
          });
          beacon(csrf, 'change');
          void refresh();
          return;
        }
        const problem = {
          status: sent.status,
          code: sent.problem?.code,
          detail: sent.problem?.detail ?? '',
        };
        setChange({ state: 'fail', problem, requestId: sent.requestId, at: Date.now() });
        beacon(csrf, 'fail', problem.code);
      } catch (e) {
        setChange({ state: 'fail', problem: problemOf(e), requestId: null, at: Date.now() });
        beacon(csrf, 'fail', 'NETWORK');
      }
    },
    [client, pass, csrf, refresh],
  );

  /** The listener heard the pass being made from a terminal: the page shows it as a call and reads the home again. */
  const heardPass = useCallback(
    (e: RequestLogEntry) => {
      setRun({
        state: 'ok',
        status: e.status,
        ms: e.durationMs,
        requestId: e.requestId,
        replayed: false,
        at: e.at,
        via: 'terminal',
        client: e.client,
      });
      if (csrf) beacon(csrf, 'run');
      void refresh();
    },
    [csrf, refresh],
  );

  /** The pass the server holds, when the page has not made or read it yet or a call from a terminal changed it. */
  const held = home?.passes[0];
  useEffect(() => {
    if (!client || !held || (pass && pass.id === held.id && pass.version >= held.version)) return;
    let live = true;
    client
      .send<PassBody>('GET', `/passes/${encodeURIComponent(held.id)}`, undefined, PORTAL_READ)
      .then(
        (sent) => {
          if (live && sent.ok && sent.body) setPass(passOf(sent.body, performance.now()));
        },
        // The stage keeps its empty card; the next read of the home tries again.
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [client, held, pass]);

  /** The stage reports the first time every wallet drew the pass; the funnel hears it once. */
  const told2 = useRef(false);
  const rendered = useCallback(
    (ms: number) => {
      setRenderedMs(ms);
      setRenderedAt((t) => t ?? Date.now());
      if (!told2.current && csrf) {
        told2.current = true;
        beacon(csrf, 'live');
      }
    },
    [csrf],
  );

  /** After a reload the page made no call, but the server knows the pass was made: show that call as it was. */
  const passAt = progress?.passAt ?? null;
  const shownRun = useMemo<Call>(() => {
    if (run.state !== 'idle' || passAt === null) return run;
    const e = home?.calls.find(
      (c) => c.method === 'POST' && c.path.endsWith('/passes') && c.status < 400,
    );
    return {
      state: 'ok',
      status: e?.status ?? 201,
      ms: e?.durationMs ?? 0,
      requestId: e?.requestId ?? null,
      replayed: false,
      at: e?.at ?? passAt,
      via: e && e.via === null ? 'terminal' : 'here',
      client: e?.client ?? null,
    };
  }, [run, passAt, home]);

  return {
    viewedAt,
    session,
    csrf,
    sandbox,
    transport,
    onContexts,
    secret,
    client,
    template,
    templateId,
    input,
    run: shownRun,
    change,
    pass,
    home,
    skew,
    progress,
    refresh,
    renderedMs,
    renderedAt,
    heardPass,
    sandboxMade,
    create,
    update,
    rendered,
  };
}

export type Quickstart = ReturnType<typeof useQuickstart>;
