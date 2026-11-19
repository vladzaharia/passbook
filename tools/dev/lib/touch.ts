// Browser context options for a phone or tablet: user agent, touch and pixel ratio, sized by viewport.
import { devices } from '@playwright/test';
import { SIZES, type ViewportName } from './routes.ts';

const PHONE = devices['iPhone 14'];
const TABLET = devices['iPad (gen 7)'];

/** A phone below 700 px wide, an iPad above; `tv` and `desktop` stay a plain desktop browser. */
export function touchOptions(viewport: ViewportName) {
  const size = SIZES[viewport];
  if (viewport === 'tv' || viewport === 'desktop') return { viewport: size };
  const base = size.width < 700 ? PHONE : TABLET;
  return {
    userAgent: base.userAgent,
    isMobile: size.width < 700,
    hasTouch: true,
    deviceScaleFactor: 2,
    viewport: size,
  };
}

/** The SVG e2e serves for the scanner gallery's branding logo (no org uploads one in the demo seed). */
export const GALLERY_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="150" viewBox="0 0 480 150"><rect width="480" height="150" rx="28" fill="#0f766e"/><circle cx="76" cy="75" r="38" fill="#d9f4ef"/><path d="M58 75h36M76 57v36" stroke="#0f766e" stroke-width="8" stroke-linecap="round"/><text x="136" y="91" fill="#fff" font-family="sans-serif" font-size="46" font-weight="700">Northwind</text></svg>`;
