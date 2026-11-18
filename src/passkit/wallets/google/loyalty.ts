/** Google Loyalty: a program with an account, points and a second balance (architecture 3.1). */
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
import type { Ctx } from './ctx.ts';
import { IDENTITY, TEXT } from './limits.ts';
import { dateLosses, locationsOf } from './parts.ts';
import type { GoogleLoyaltyClass, GoogleLoyaltyObject, GooglePoints } from './types.ts';
import { micros } from './values.ts';

/** Points as the class shows them: a count where the value is a number, else the text as written. */
function pointsOf(ctx: Ctx): GooglePoints | undefined {
  const points = ctx.take('points');
  if (!points) return undefined;
  const labelRole = ctx.take('pointsLabel');
  const label = (labelRole && ctx.roleText('pointsLabel')) || ctx.labelOf('points') || 'Points';
  const shown = ctx.display('points.label', label, TEXT.title);
  if (points.kind === 'number')
    return {
      label: shown,
      balance: Number.isInteger(points.number) ? { int: points.number } : { double: points.number },
    };
  return {
    label: shown,
    balance: { string: ctx.display('points', ctx.roleText('points') ?? '', TEXT.title) },
  };
}

function secondaryOf(ctx: Ctx): GooglePoints | undefined {
  const balance = ctx.role('balance');
  const amount = balance?.kind === 'money' ? micros(balance.amount) : undefined;
  if (balance?.kind !== 'money' || amount === undefined || !ctx.take('balance')) return undefined;
  return {
    label: ctx.display('balance.label', ctx.labelOf('balance') ?? 'Balance', TEXT.title),
    balance: { money: { micros: amount, currencyCode: balance.currencyCode } },
  };
}

export const googleLoyaltyCompiler = makeCompiler({
  type: 'loyalty',
  unmet: () => undefined,
  build(ctx) {
    const { view } = ctx;
    const programLogo = logoOf(ctx, { ...LOGO, loss: 'omitted' });
    if (!programLogo) return NEEDS_LOGO;
    const wideProgramLogo = wideLogoOf(ctx);
    const hero = heroOf(ctx);
    const memberId = ctx.take('memberId');
    const memberName = ctx.take('memberName');
    const accountId = memberId && ctx.roleText('memberId');
    const accountName = memberName && ctx.roleText('memberName');
    const loyaltyPoints = pointsOf(ctx);
    const secondaryLoyaltyPoints = secondaryOf(ctx);
    const locations = locationsOf(ctx);
    const validUntil = ctx.take('validUntil');
    dateLosses(ctx, false);
    const common = objectCommon(ctx, {
      end: validUntil?.kind === 'date' ? validUntil.iso : undefined,
      start: undefined,
      events: false,
    });

    const classBody: GoogleLoyaltyClass = {
      ...typedClass(ctx, hero),
      programName: ctx.display('org', view.org, TEXT.title),
      programLogo,
      ...(wideProgramLogo ? { wideProgramLogo } : {}),
      ...(ctx.labelOf('memberId')
        ? {
            accountIdLabel: ctx.display(
              'memberId.label',
              ctx.labelOf('memberId') ?? '',
              TEXT.title,
            ),
          }
        : {}),
      ...(ctx.labelOf('memberName')
        ? {
            accountNameLabel: ctx.display(
              'memberName.label',
              ctx.labelOf('memberName') ?? '',
              TEXT.title,
            ),
          }
        : {}),
    };
    const objectBody: GoogleLoyaltyObject = {
      ...(accountId ? { accountId: ctx.identity('memberId', accountId, IDENTITY) } : {}),
      ...(accountName ? { accountName: ctx.display('memberName', accountName, TEXT.title) } : {}),
      ...(loyaltyPoints ? { loyaltyPoints } : {}),
      ...(secondaryLoyaltyPoints ? { secondaryLoyaltyPoints } : {}),
      ...(locations ? { locations } : {}),
      ...common,
    };
    return { classBody, objectBody };
  },
});
