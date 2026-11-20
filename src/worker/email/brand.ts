import type { OrgBrand } from '../../shared/contracts/brand.ts';
import { baseUrl } from '../platform/env.ts';
import type { EmailBrand } from './shell.ts';

/** The band's logo box: a line of type and a bit, at most this wide. */
const BOX = { w: 176, h: 32 };

/** The org's brand as an email draws it: the web logo by absolute URL at its band size, and the mark. */
export function emailBrandOf(env: { PUBLIC_BASE_URL: string }, brand: OrgBrand): EmailBrand {
  const logo = brand.logo;
  if (!logo) return { logo: null, mark: brand.mark };
  const scale = Math.min(1, BOX.h / logo.h, BOX.w / logo.w);
  return {
    logo: {
      url: `${baseUrl(env)}${logo.path}`,
      width: Math.max(1, Math.round(logo.w * scale)),
      height: Math.max(1, Math.round(logo.h * scale)),
    },
    mark: brand.mark,
  };
}
