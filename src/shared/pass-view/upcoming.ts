import type { PassJson } from '../../passkit/types.ts';
import type { FormatContext } from './format.ts';
import { placeDate } from './semantic.ts';
import type { UpcomingView } from './types.ts';

type Dict = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Entries of `upcomingPassInformation`, ready to list like Wallet's event rows. */
export function upcomingEvents(pass: PassJson, ctx: FormatContext): UpcomingView[] {
  const entries: unknown = pass.upcomingPassInformation;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap<UpcomingView>((raw, i) => {
    if (!isDict(raw)) return [];
    const name = str(raw.name);
    if (!name) return [];
    const info = isDict(raw.dateInformation) ? raw.dateInformation : {};
    const s = isDict(raw.semantics) ? raw.semantics : {};
    const venue = str(s.venueName) ?? str(s.venueRegionName);
    const base = {
      id: str(raw.identifier) ?? `event-${i}`,
      name,
      ...(venue ? { venue } : {}),
      active: raw.isActive === true,
    };
    const at = placeDate(info.date, ctx, { zone: info.timeZone, local: true });
    if (!at || info.isUndetermined === true || info.isUnannounced === true)
      return [{ ...base, dated: false, when: 'Date to be announced' }];
    const fmt = (o: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(ctx.locale, {
        ...o,
        ...(at.timeZone ? { timeZone: at.timeZone } : {}),
      }).format(at.date);
    const allDay = info.isAllDay === true || info.ignoreTimeComponents === true;
    return [
      {
        ...base,
        dated: true,
        dateTime: String(info.date),
        month: fmt({ month: 'short' }),
        day: fmt({ day: 'numeric' }),
        when: allDay
          ? fmt({ weekday: 'short', month: 'short', day: 'numeric' })
          : `${fmt({ weekday: 'short' })}, ${fmt({ hour: 'numeric', minute: '2-digit' })}`,
      },
    ];
  });
}
