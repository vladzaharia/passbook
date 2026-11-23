import { useQuery } from '@tanstack/react-query';
import { ArrowRight, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { PassSetupField, PassSetupPatch } from '@/shared/contracts/pass-setup.ts';
import { CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  ErrorState,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { patchPassSetup } from './api.ts';

const COPY = PASS_SETUP_COPY;
type Json = unknown;

function Swatches({
  colors,
}: {
  colors: { background: string; foreground: string; label: string };
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="inline-flex">
        {[colors.background, colors.foreground, colors.label].map((c) => (
          <span
            key={c}
            className="-ml-1 size-4 rounded-full border border-border-strong first:ml-0"
            style={{ background: c }}
          />
        ))}
      </span>
      <span className="font-mono text-xs">{colors.background}</span>
    </span>
  );
}

const isColors = (v: Json): v is { background: string; foreground: string; label: string } =>
  typeof v === 'object' && v !== null && 'background' in v && 'foreground' in v && 'label' in v;

/** One side of a diff row: swatches for colours, words for switches and images, else the text. */
function sideText(field: PassSetupField, v: Json): ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  if (isColors(v)) return <Swatches colors={v} />;
  if (field === 'brand.mark' && (v === 'full' || v === 'small' || v === 'none'))
    return COPY.brand.markOptions[v];
  if (field.startsWith('channels.')) return v === true || v === 'allowed' ? 'Allowed' : 'Blocked';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'object') return 'Image';
  return String(v);
}

/** What the save will do, from the server's dry run: the same impact an API caller reads. */
export function ReviewDialog({
  orgId,
  patch,
  open,
  onOpenChange,
  onConfirm,
  saving,
}: {
  orgId: string;
  patch: PassSetupPatch | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  saving: boolean;
}) {
  const dry = useQuery({
    queryKey: ['orgs', 'pass-setup', orgId, 'dry-run', JSON.stringify(patch)],
    enabled: open && patch !== null,
    retry: false,
    gcTime: 0,
    queryFn: () =>
      patch ? patchPassSetup(orgId, patch, true) : Promise.reject(new Error('empty')),
  });
  const result = dry.data;
  const n = result?.diff.length ?? 0;
  const blocks = (result?.impact.channelStops.length ?? 0) > 0;
  const title = n === 1 ? COPY.review.titleOne : scanLine(COPY.review.title, { n });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={result ? title : COPY.page.review}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {COPY.page.back}
            </Button>
            <Button
              variant={blocks ? 'danger' : 'primary'}
              loading={saving}
              disabled={!result}
              onClick={onConfirm}
            >
              {blocks ? COPY.review.blockAndSave : COPY.review.save}
            </Button>
          </>
        }
      >
        {dry.isPending ? (
          <SkeletonRows rows={3} label="Checking the change" />
        ) : dry.isError || !result ? (
          <ErrorState inline subject="the change" error={dry.error} onRetry={() => dry.refetch()} />
        ) : (
          <div className="flex flex-col gap-4">
            <ul className="m-0 list-none divide-y divide-border rounded-lg border border-border p-0">
              {result.diff.map((d) => (
                <li
                  key={d.field}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                >
                  <span className="w-32 shrink-0 text-fg-muted">{COPY.fields[d.field]}</span>
                  <span className="text-fg-muted line-through">{sideText(d.field, d.before)}</span>
                  <ArrowRight aria-hidden className="size-3.5 text-fg-muted" />
                  <span className="font-medium text-fg-strong">{sideText(d.field, d.after)}</span>
                </li>
              ))}
            </ul>
            {result.impact.passesToUpdate > 0 ? (
              <Callout tone="info" icon={RefreshCw}>
                {result.impact.passesToUpdate === 1
                  ? COPY.impact.passesOne
                  : scanLine(COPY.impact.passes, { n: result.impact.passesToUpdate })}
              </Callout>
            ) : null}
            {result.impact.channelStops.length > 0 ? (
              <Callout tone="warning" icon={TriangleAlert}>
                <ul className="m-0 list-none p-0">
                  {result.impact.channelStops.map((s) => (
                    <li key={s.channel}>
                      {scanLine(COPY.impact.stops, {
                        channel: CHANNEL_LABEL[s.channel],
                        templates: `${s.templates} ${s.templates === 1 ? 'template' : 'templates'}`,
                        passes: `${s.passes} ${s.passes === 1 ? 'pass' : 'passes'}`,
                      })}
                    </li>
                  ))}
                </ul>
                {COPY.impact.copiesKeep}
              </Callout>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
