/** Google Generic: the type for everything without a typed fit (architecture 3.1, 3.2). */
import { heroOf, LOGO, logoOf, objectCommon, wideLogoOf } from './common.ts';
import { makeCompiler } from './compile.ts';
import { TEXT } from './limits.ts';
import { backgroundColor, dateLosses, locationsOf } from './parts.ts';
import type { GoogleGenericObject } from './types.ts';

/** The next event with a date: the one marked active, else the first. */
const nextEventDate = (events: readonly { date?: string; active: boolean }[]) =>
  (events.find((e) => e.active && e.date) ?? events.find((e) => e.date))?.date;

export const googleGenericCompiler = makeCompiler({
  type: 'generic',
  unmet: () => undefined,
  build(ctx) {
    const { view } = ctx;
    const title = ctx.take('title');
    const subtitle = ctx.take('subtitle');
    const validFrom = ctx.take('validFrom');
    const validUntil = ctx.take('validUntil');
    const eventStart = ctx.role('eventStart');
    const eventEnd = ctx.role('eventEnd');
    const explicitFrom = validFrom && validFrom.source !== 'style' ? validFrom : undefined;
    const start =
      (explicitFrom?.kind === 'date' ? explicitFrom.iso : undefined) ??
      (eventStart?.kind === 'date' ? eventStart.iso : undefined) ??
      nextEventDate(view.events) ??
      (validFrom?.kind === 'date' ? validFrom.iso : undefined);
    const end =
      (validUntil?.kind === 'date' ? validUntil.iso : undefined) ??
      (eventEnd?.kind === 'date' ? eventEnd.iso : undefined);

    const logo = logoOf(ctx, {
      ...LOGO,
      loss: 'difference',
      fallback: 'Google shows the first letter of the title.',
    });
    const wideLogo = wideLogoOf(ctx);
    const heroImage = heroOf(ctx);
    const merchantLocations = locationsOf(ctx);
    dateLosses(ctx, true);
    const common = objectCommon(ctx, { start, end, events: true });
    const subheaderText = subtitle ? ctx.roleText('subtitle') : undefined;
    const hex = backgroundColor(ctx);

    const objectBody: GoogleGenericObject = {
      genericType: 'GENERIC_OTHER',
      cardTitle: ctx.localized('org', view.org, TEXT.title),
      header: ctx.localized('title', (title && ctx.roleText('title')) ?? view.org, TEXT.title),
      ...(subheaderText ? { subheader: ctx.localized('subtitle', subheaderText, TEXT.line) } : {}),
      ...(logo ? { logo } : {}),
      ...(wideLogo ? { wideLogo } : {}),
      ...(heroImage ? { heroImage } : {}),
      ...(hex ? { hexBackgroundColor: hex } : {}),
      ...(merchantLocations ? { merchantLocations } : {}),
      ...(view.relevance.dates.length > 0 && common.validTimeInterval?.start
        ? { notifications: { upcomingNotification: { enableNotification: true as const } } }
        : {}),
      ...common,
    };
    return {
      classBody: { multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES' },
      objectBody,
    };
  },
});
