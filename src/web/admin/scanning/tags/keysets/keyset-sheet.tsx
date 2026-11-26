import { ArrowRightLeft, KeyRound, ShieldX, Upload } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import { formatDateTime, pluralize } from '@/web/lib/format.ts';
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  ErrorState,
  KeyValue,
  Sheet,
  SheetContent,
  SkeletonKeyValue,
  StatusPill,
  toast,
} from '@/web/ui/index.ts';
import { type Keyset, useKeysets, useKeysetWrites } from './api.ts';
import { ImportDialog } from './import-dialog.tsx';
import { DisableDialog, ReenrolDialog, RevokeDialog } from './recover-dialogs.tsx';
import { RotateDialog } from './rotate-dialog.tsx';
import { SdmProfile } from './sdm-profile.tsx';
import { fill, kindOf, tagCount, tagUrl } from './words.ts';

type Open =
  | { is: 'rotate' | 'import' | 'reenrol' | 'disable' }
  | { is: 'revoke'; version: number }
  | null;

const STATE = KEYSET_COPY.state;

/** One keyset: its keys by version with what each leaves behind, and the ways to rotate, cut off or move. */
export function KeysetSheet({
  orgId,
  id,
  canManage,
  onClose,
}: {
  orgId: string;
  id: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const query = useKeysets(orgId);
  const writes = useKeysetWrites(orgId);
  const [open, setOpen] = useState<Open>(null);
  const keyset = query.data?.items.find((k) => k.id === id);
  const disabled = keyset?.disabledAt != null;
  const close = () => setOpen(null);
  return (
    <>
      <Sheet open onOpenChange={(o) => !o && onClose()}>
        <SheetContent title={keyset?.name ?? 'Keyset'} className="sm:w-[480px]">
          <div className="flex flex-col gap-5 p-5">
            {query.isPending ? (
              <SkeletonKeyValue label="Loading keyset" />
            ) : query.isError ? (
              <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />
            ) : !keyset ? (
              <Callout tone="warning">This keyset is gone.</Callout>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <h2 className="text-lg font-semibold text-fg-strong">{keyset.name}</h2>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{kindOf(keyset)}</Badge>
                    <StatusPill status={disabled ? 'disabled' : 'active'} />
                  </div>
                </div>
                {disabled ? (
                  <Callout tone="warning">
                    Disabled. Its tags don't work. Move them to a new keyset to use them again.
                  </Callout>
                ) : null}
                <KeyValue
                  items={[
                    {
                      label: 'Tag URL',
                      value: (
                        <span className="flex items-center gap-1">
                          <span className="min-w-0 break-all">{tagUrl(keyset.slug)}</span>
                          <CopyButton value={tagUrl(keyset.slug)} label="Copy tag URL" />
                        </span>
                      ),
                      mono: true,
                    },
                    { label: 'Tags', value: tagCount(keyset) },
                    { label: 'Created', value: formatDateTime(keyset.createdAt) },
                    ...(disabled
                      ? [{ label: 'Disabled', value: formatDateTime(keyset.disabledAt) }]
                      : []),
                  ]}
                />
                <Versions
                  keyset={keyset}
                  canManage={canManage}
                  disabled={disabled}
                  onRevoke={(version) => setOpen({ is: 'revoke', version })}
                  onRetire={(v) =>
                    writes
                      .retire(keyset.id, v)
                      .then(() => toast.success(`Version ${v} retired`))
                      .catch((cause) => toast.error(cause, 'Could not retire'))
                  }
                />
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    {disabled ? null : (
                      <Button
                        variant="outline"
                        iconStart={<KeyRound aria-hidden />}
                        onClick={() => setOpen({ is: 'rotate' })}
                      >
                        Rotate keys
                      </Button>
                    )}
                    {keyset.perTag && !disabled ? (
                      <Button
                        variant="outline"
                        iconStart={<Upload aria-hidden />}
                        onClick={() => setOpen({ is: 'import' })}
                      >
                        Import tags
                      </Button>
                    ) : null}
                    {!keyset.perTag && tagCount(keyset) > 0 ? (
                      <Button
                        variant="outline"
                        iconStart={<ArrowRightLeft aria-hidden />}
                        onClick={() => setOpen({ is: 'reenrol' })}
                      >
                        Move tags
                      </Button>
                    ) : null}
                    {disabled ? null : (
                      <Button
                        variant="outline"
                        iconStart={<ShieldX aria-hidden />}
                        onClick={() => setOpen({ is: 'disable' })}
                      >
                        Disable
                      </Button>
                    )}
                  </div>
                ) : null}
                {disabled ? null : (
                  <Section title="Write each tag with">
                    <SdmProfile keyset={keyset} />
                  </Section>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
      {keyset && open?.is === 'rotate' ? (
        <RotateDialog keyset={keyset} rotate={writes.rotate} onClose={close} />
      ) : null}
      {keyset && open?.is === 'import' ? (
        <ImportDialog
          keyset={keyset}
          run={(body) => writes.importTags(keyset.id, body)}
          onClose={close}
        />
      ) : null}
      {keyset && open?.is === 'revoke' ? (
        <RevokeDialog
          keyset={keyset}
          version={open.version}
          revoke={() => writes.revoke(keyset.id, open.version)}
          onClose={close}
        />
      ) : null}
      {keyset && open?.is === 'disable' ? (
        <DisableDialog keyset={keyset} disable={() => writes.disable(keyset.id)} onClose={close} />
      ) : null}
      {keyset && open?.is === 'reenrol' ? (
        <ReenrolDialog
          keyset={keyset}
          targets={(query.data?.items ?? []).filter(
            (k) => k.id !== keyset.id && k.disabledAt === null && !k.perTag,
          )}
          reenrol={(toKeysetId) => writes.reenrol(keyset.id, { toKeysetId })}
          onClose={close}
        />
      ) : null}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-fg-strong">{title}</h3>
      {children}
    </section>
  );
}

function Versions({
  keyset,
  canManage,
  disabled,
  onRevoke,
  onRetire,
}: {
  keyset: Keyset;
  canManage: boolean;
  disabled: boolean;
  onRevoke: (version: number) => void;
  onRetire: (version: number) => void;
}) {
  return (
    <Section title="Key versions">
      <ul
        className="divide-y divide-border rounded-md border border-border"
        aria-label="Key versions"
      >
        {[...keyset.versions].reverse().map((v) => {
          const revoked = v.revokedAt !== null;
          const state = revoked ? STATE.revoked : STATE[v.state];
          return (
            <li
              key={v.version}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-medium text-fg-strong">
                  Version {v.version} · {state}
                </span>
                <span className={revoked && v.tags > 0 ? 'text-warning' : 'text-fg-muted'}>
                  {v.tags === 0
                    ? 'No tags'
                    : revoked
                      ? fill(KEYSET_COPY.needKeys, { n: v.tags })
                      : pluralize(v.tags, 'tag')}
                </span>
              </div>
              {canManage && !disabled && v.state !== 'retired' ? (
                <div className="flex gap-2">
                  {v.state === 'retiring' && v.tags === 0 ? (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Retire version ${v.version}`}
                      onClick={() => onRetire(v.version)}
                    >
                      Retire
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Revoke version ${v.version}`}
                    onClick={() => onRevoke(v.version)}
                  >
                    Revoke
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
