import { useRef, useState } from 'react';
import type { BrandKit } from '@/shared/contracts/brand.ts';
import { contrast, parseColor } from '@/shared/pass-view/color.ts';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { handleStaleSave } from '@/web/lib/stale-save.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  FileDrop,
  IconButton,
  RadioGroup,
  SkeletonRows,
  toast,
} from '@/web/ui/index.ts';
import { HEX, ImageInputError } from '../orgs/branding.ts';
import { ColorField } from '../orgs/color-field.tsx';
import { prepareWebLogo, useBrandKit, useBrandMutations } from './brand-queries.ts';

const MARKS = [
  { value: 'full', label: 'Full', hint: 'The PassBook wordmark at the foot of pages and emails.' },
  { value: 'small', label: 'Small', hint: 'One line: Powered by PassBook.' },
  { value: 'none', label: 'None', hint: 'No PassBook mark.' },
] as const;

const LIGHT_PAGE = '#f6f8ff';
const DARK_PAGE = '#060912';

/** One sentence per theme where the accent is too faint to see (under 3:1 against the page). */
function accentWarnings(accent: string): string[] {
  const color = parseColor(accent);
  if (!HEX.test(accent) || !color) return [];
  const out: string[] = [];
  for (const [name, page] of [
    ['light', LIGHT_PAGE],
    ['dark', DARK_PAGE],
  ] as const) {
    const bg = parseColor(page);
    const ratio = bg ? contrast(color, bg) : 21;
    if (ratio < 3)
      out.push(`On ${name} pages the accent is ${ratio.toFixed(1)}:1, so holders see the default.`);
  }
  return out;
}

function WebLogo({ kit }: { kit: BrandKit }) {
  const { upload, remove } = useBrandMutations(kit.orgId);
  const kitQuery = useBrandKit(kit.orgId);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const busy = upload.isPending || remove.isPending;
  const logo = kit.webLogo;

  async function take(files: File[]) {
    const [file] = files;
    if (!file) return;
    setError(undefined);
    try {
      await upload.mutateAsync({
        png: await prepareWebLogo(file),
        configRevision: kit.configRevision,
      });
      toast.success('Web logo uploaded.');
    } catch (cause) {
      if (handleStaleSave(cause, kitQuery.refetch)) return;
      setError(cause instanceof ImageInputError ? cause.message : errorMessage(cause));
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-sm font-medium text-fg">Web logo</span>
      {logo ? (
        <div className="flex min-h-24 items-center gap-3 rounded-lg border border-border bg-surface-sunken p-3">
          <img
            src={logo.url}
            alt={`${kit.name} web logo`}
            width={logo.w}
            height={logo.h}
            className="max-h-14 min-w-0 object-contain"
          />
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              loading={busy}
              busy="bob"
              aria-label="Replace web logo"
              iconStart={<ACTION_ICON.upload aria-hidden />}
              onClick={() => input.current?.click()}
            >
              Replace
            </Button>
            <input
              ref={input}
              type="file"
              accept=".png,image/png"
              tabIndex={-1}
              aria-hidden
              className="sr-only"
              onChange={(e) => {
                void take(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <IconButton
              label="Remove web logo"
              size="sm"
              disabled={busy}
              icon={<ACTION_ICON.delete aria-hidden />}
              onClick={() =>
                remove.mutateAsync(kit.configRevision).then(
                  () => toast.success('Web logo removed.'),
                  (cause) => toast.error(cause, 'Could not remove'),
                )
              }
            />
          </span>
        </div>
      ) : (
        <FileDrop
          accept=".png,image/png"
          maxBytes={512 * 1024}
          label="Choose web logo"
          disabled={busy}
          onFiles={(files) => void take(files)}
          className="[&>div]:min-h-24 [&>div]:py-4"
        />
      )}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : (
        <p className="text-xs text-fg-muted">
          PNG, up to 1024 × 512 px and 512 KB. Leads pass, bundle and join pages and emails.
        </p>
      )}
    </div>
  );
}

function KitForm({ kit, refetch }: { kit: BrandKit; refetch: () => unknown }) {
  const { update } = useBrandMutations(kit.orgId);
  const [accent, setAccent] = useState(kit.accent ?? '');
  const [mark, setMark] = useState<string>(kit.markChosen);
  const invalid = accent !== '' && !HEX.test(accent);
  const dirty = accent !== (kit.accent ?? '') || mark !== kit.markChosen;
  const warnings = accentWarnings(accent);
  const options = MARKS.map((m) => ({
    value: m.value,
    label: m.label,
    hint: kit.markAllowed.includes(m.value) ? m.hint : 'Not available for this organization.',
    disabled: !kit.markAllowed.includes(m.value),
  }));

  async function save() {
    try {
      await update.mutateAsync({
        accent: accent === '' ? null : accent,
        mark,
        configRevision: kit.configRevision,
      });
      toast.success('Brand saved.');
    } catch (cause) {
      if (!handleStaleSave(cause, refetch)) toast.error(cause, 'Could not save');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ColorField
        label="Accent"
        value={accent}
        fallback="#0f766e"
        empty="Default"
        error={invalid ? 'Use a hex colour like #0f766e.' : undefined}
        help="Buttons and links on holder pages."
        onChange={setAccent}
      />
      {warnings.length ? <Callout tone="warning" items={warnings} /> : null}
      <RadioGroup legend="PassBook mark" options={options} value={mark} onValueChange={setMark} />
      <div>
        <Button loading={update.isPending} disabled={!dirty || invalid} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

/** Web logo, accent and mark level: the org's look on holder pages and emails. */
export function BrandSection({ orgId }: { orgId: string }) {
  const query = useBrandKit(orgId);
  const kit = query.data;
  return (
    <Card>
      <CardHeader title="Brand" />
      <CardBody className="@container">
        {query.isPending ? (
          <SkeletonRows rows={3} label="Loading brand" />
        ) : query.isError || !kit ? (
          <ErrorState subject="brand" error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <div className="grid gap-6 @[40rem]:grid-cols-2">
            <WebLogo kit={kit} />
            {/* Remount on a new revision, so a save or a reload starts from the stored values. */}
            <KitForm key={kit.configRevision} kit={kit} refetch={query.refetch} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}
