import { useEffect, useRef, useState } from 'react';
import { useUnsaved } from '../settings/drafts.ts';
import { type Draft, ORG_FIELDS, parseField } from '../settings/fields.ts';

/** The email as a phone shows it, where most holders read it; wider up to its 480 px column. */
const PHONE = 390;
const COLUMN = 512;
/** Typing settles before the frame reloads. */
const SETTLE_MS = 400;

const PARAMS = { 'support.email': 'supportEmail', 'support.url': 'supportUrl' } as const;
const SUPPORT = ORG_FIELDS.filter((f) => f.key in PARAMS);

/**
 * The unsaved support contacts as preview params (empty clears one, as Save would), or null while
 * one is not valid: the frame keeps the last email Save could produce.
 */
function supportParams(unsaved: Draft): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const f of SUPPORT) {
    const raw = unsaved[f.key];
    if (raw === undefined) continue;
    const parsed = parseField(f, raw);
    if (parsed.error) return null;
    out[PARAMS[f.key as keyof typeof PARAMS]] =
      typeof parsed.value === 'string' ? parsed.value : '';
  }
  return out;
}

/** The query once it stops changing; a null one keeps the last. */
function useSettled(query: string | null, ms: number): string {
  const [settled, setSettled] = useState(query ?? '');
  useEffect(() => {
    if (query === null) return;
    const t = setTimeout(() => setSettled(query), ms);
    return () => clearTimeout(t);
  }, [query, ms]);
  return settled;
}

/** The width the frame gets from its column. */
function useAvailableWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The org's real pass email (rendered by the Worker with sample holder data), in an iframe that
 * cannot run scripts. It follows the page's unsaved buddy and support contacts, and reloads after
 * a logo or icon upload (`version`). Laid out at a phone's width, scaled down to fit the column.
 */
export function PassEmailPreview({
  orgId,
  buddy,
  version,
}: {
  orgId: string;
  buddy: boolean;
  version: number;
}) {
  const unsaved = useUnsaved(`org:${orgId}`);
  const support = supportParams(unsaved);
  const settled = useSettled(support ? new URLSearchParams(support).toString() : null, SETTLE_MS);
  const [box, available] = useAvailableWidth();
  const [height, setHeight] = useState(560);
  // Inside the frame's 1 px border.
  const inner = available - 2;
  const width = Math.min(COLUMN, Math.max(PHONE, inner));
  const scale = inner > 0 ? Math.min(1, inner / width) : 1;
  const query = [`buddy=${buddy ? 1 : 0}`, settled, `v=${version}`].filter(Boolean).join('&');
  const src = `/api/v1/orgs/${encodeURIComponent(orgId)}/email-preview?${query}`;
  return (
    <div ref={box} className="flex min-w-0 flex-col items-center gap-2">
      <div
        className="overflow-hidden rounded-lg border border-border bg-surface-page"
        style={{ width: width * scale + 2, height: height * scale + 2 }}
      >
        <iframe
          title="Sample pass email"
          src={src}
          // Same origin only so the images load with the admin session; no scripts, forms or popups.
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          className="block origin-top-left border-0"
          style={{ width, height, transform: scale < 1 ? `scale(${scale})` : undefined }}
          onLoad={(e) => {
            // The body, not the document: its scroll height never drops below the frame's.
            const body = e.currentTarget.contentDocument?.body;
            const h = body ? Math.ceil(body.getBoundingClientRect().height) : 0;
            if (h) setHeight(h);
          }}
        />
      </div>
      <p className="text-xs text-fg-muted">Sample email</p>
    </div>
  );
}
