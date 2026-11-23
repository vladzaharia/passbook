/** Google Offer: a title, details and fine print on the class (architecture 3.1). */
import { heroOf, LOGO, logoOf, objectCommon, typedClass, wideLogoOf } from './common.ts';
import { makeCompiler } from './compile.ts';
import { TEXT } from './limits.ts';
import { dateLosses, locationsOf } from './parts.ts';
import type { GoogleOfferClass, GoogleOfferObject, GoogleRedemption } from './types.ts';

const CHANNELS = { online: 'ONLINE', instore: 'INSTORE', both: 'BOTH' } as const;

export const googleOfferCompiler = makeCompiler({
  type: 'offer',
  unmet: (view) =>
    view.roles.offerTitle && view.roles.redemptionChannel
      ? undefined
      : 'An offer needs a title and a redemption channel.',
  build(ctx) {
    const { view } = ctx;
    const titleRole = ctx.take('offerTitle');
    const title = titleRole && ctx.roleText('offerTitle');
    const channel = ctx.take('redemptionChannel');
    if (!title || channel?.kind !== 'channel')
      return 'An offer needs a title and a redemption channel.';
    const finePrint = ctx.take('finePrint') && ctx.roleText('finePrint');
    // A template that sets `finePrint` puts its constant terms on the shared class; the details role is
    // then per-pass text, and its fields stay on the object.
    const details = !finePrint && ctx.take('offerDetails') && ctx.roleText('offerDetails');
    const titleImage = logoOf(ctx, {
      ...LOGO,
      loss: 'difference',
      fallback: 'Google shows the provider name.',
    });
    const wideTitleImage = wideLogoOf(ctx);
    const hero = heroOf(ctx);
    const locations = locationsOf(ctx);
    const validFrom = ctx.take('validFrom');
    const validUntil = ctx.take('validUntil');
    dateLosses(ctx, true);
    const common = objectCommon(ctx, {
      start: validFrom?.kind === 'date' ? validFrom.iso : undefined,
      end: validUntil?.kind === 'date' ? validUntil.iso : undefined,
      events: false,
    });

    const plain = (path: string, text: string, limit: typeof TEXT.line) =>
      ctx.display(path, text, limit);
    const twin = (text: string, limit: typeof TEXT.line) => ctx.localizedTwin(text, limit);
    const localizedTitle = twin(title, TEXT.line);
    const localizedDetails = details ? twin(details, TEXT.long) : undefined;
    const localizedFinePrint = finePrint ? twin(finePrint, TEXT.long) : undefined;
    const classBody: GoogleOfferClass = {
      ...typedClass(ctx, hero),
      provider: plain('org', view.org, TEXT.title),
      title: plain('offerTitle', title, TEXT.line),
      ...(localizedTitle ? { localizedTitle } : {}),
      redemptionChannel: CHANNELS[channel.channel] as GoogleRedemption,
      ...(details ? { details: plain('offerDetails', details, TEXT.long) } : {}),
      ...(localizedDetails ? { localizedDetails } : {}),
      ...(finePrint ? { finePrint: plain('finePrint', finePrint, TEXT.long) } : {}),
      ...(localizedFinePrint ? { localizedFinePrint } : {}),
      ...(titleImage ? { titleImage } : {}),
      ...(wideTitleImage ? { wideTitleImage } : {}),
    };
    const objectBody: GoogleOfferObject = { ...(locations ? { locations } : {}), ...common };
    return { classBody, objectBody };
  },
});
