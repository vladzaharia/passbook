import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import {
  type BuddySlice,
  buddyPath,
  type EmailScheme,
  PASS_EMAIL_MOOD,
} from '@/shared/email-art.ts';
import { useTheme } from '@/web/lib/theme.tsx';

/** The email's own art (public/email), drawn at half its 128 px width. */
const art = (scheme: EmailScheme, slice: BuddySlice) =>
  buddyPath(PASS_EMAIL_MOOD, scheme, slice, 2);

/**
 * The top of the pass email as holders get it: the org's name on the page and, when on, the buddy
 * seated on the card's foil edge at the band's right end (src/worker/email/shell.ts), happy.
 */
export function PassEmailPreview({ orgName, buddy }: { orgName: string; buddy: boolean }) {
  const { resolved } = useTheme();
  return (
    <div className="flex min-w-0 flex-col items-center gap-2">
      <div
        aria-hidden
        data-buddy={buddy || undefined}
        className="w-full overflow-hidden rounded-lg border border-border bg-surface-page px-3 pt-2"
      >
        <div className="flex h-11 items-end justify-between gap-2">
          <span className="min-w-0 truncate pb-1.5 pl-3 text-sm font-semibold tracking-tight text-fg-strong">
            {orgName}
          </span>
          {buddy ? (
            <img
              src={art(resolved, 'top')}
              alt=""
              width={64}
              height={44}
              className="mr-0.5 h-11 w-16 shrink-0"
            />
          ) : null}
        </div>
        {/* As the email's card: no top border, the foil along its rounded top edge. */}
        <div className="relative overflow-hidden rounded-t-xl border border-t-0 border-b-0 border-border bg-surface-raised bg-(image:--wl-foil) bg-size-[100%_2px] bg-no-repeat">
          {buddy ? (
            <img
              src={art(resolved, 'legs')}
              alt=""
              width={64}
              height={6}
              className="absolute top-0 right-px h-1.5 w-16"
            />
          ) : null}
          <div className="flex flex-col gap-2 px-3 pt-3 pb-3">
            <span className="text-sm font-semibold text-fg-strong">{HOLDER_COPY.passReady}</span>
            <span className="h-9 rounded-md bg-surface-sunken" />
          </div>
        </div>
      </div>
      <p className="text-xs text-fg-muted">Sample email</p>
    </div>
  );
}
