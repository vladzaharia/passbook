/** Google Gift card: card number, pin and balance (architecture 3.1). */
import {
  heroOf,
  LOGO,
  logoOf,
  NEEDS_LOGO,
  objectCommon,
  typedClass,
  wideLogoOf,
} from './common.ts';
import { makeCompiler } from './compile.ts';
import { IDENTITY, TEXT } from './limits.ts';
import { dateLosses, locationsOf } from './parts.ts';
import type { GoogleGiftClass, GoogleGiftObject, GoogleMoney } from './types.ts';
import { micros } from './values.ts';

export const googleGiftCompiler = makeCompiler({
  type: 'gift',
  unmet: (view) => (view.roles.giftCardNumber ? undefined : 'A gift card needs a card number.'),
  build(ctx) {
    const { view } = ctx;
    const programLogo = logoOf(ctx, { ...LOGO, loss: 'omitted' });
    if (!programLogo) return NEEDS_LOGO;
    const wideProgramLogo = wideLogoOf(ctx);
    const hero = heroOf(ctx);
    const number = ctx.take('giftCardNumber');
    if (!number) return 'A gift card needs a card number.';
    const pin = ctx.take('giftCardPin');
    const money = ctx.role('balance');
    const amount = money?.kind === 'money' ? micros(money.amount) : undefined;
    const balance: GoogleMoney | undefined =
      money?.kind === 'money' && amount !== undefined && ctx.take('balance')
        ? { micros: amount, currencyCode: money.currencyCode }
        : undefined;
    const locations = locationsOf(ctx);
    const validUntil = ctx.take('validUntil');
    dateLosses(ctx, false);
    const common = objectCommon(ctx, {
      end: validUntil?.kind === 'date' ? validUntil.iso : undefined,
      start: undefined,
      events: false,
    });
    const label = (name: string | undefined, path: string) =>
      name ? ctx.display(path, name, TEXT.title) : undefined;
    const numberLabel = label(ctx.labelOf('giftCardNumber'), 'giftCardNumber.label');
    const pinLabel = label(ctx.labelOf('giftCardPin'), 'giftCardPin.label');
    const balanceLabel = balance ? label(ctx.labelOf('balance'), 'balance.label') : undefined;

    const classBody: GoogleGiftClass = {
      ...typedClass(ctx, hero),
      merchantName: ctx.display('org', view.org, TEXT.title),
      programLogo,
      ...(wideProgramLogo ? { wideProgramLogo } : {}),
      ...(numberLabel ? { cardNumberLabel: numberLabel } : {}),
      ...(pinLabel ? { pinLabel } : {}),
      ...(balanceLabel ? { balanceLabel } : {}),
    };
    const objectBody: GoogleGiftObject = {
      cardNumber: ctx.identity('giftCardNumber', ctx.roleText('giftCardNumber') ?? '', IDENTITY),
      ...(pin
        ? { pin: ctx.identity('giftCardPin', ctx.roleText('giftCardPin') ?? '', IDENTITY) }
        : {}),
      ...(balance ? { balance } : {}),
      ...(locations ? { locations } : {}),
      ...common,
    };
    return { classBody, objectBody };
  },
});
