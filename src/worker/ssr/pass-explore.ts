import type { AddDirection } from '../../shared/add-direction.ts';
import addCss from '../../web/portal/add/add.css?raw';
import addA from '../../web/portal/add/add-a.css?raw';
import addB from '../../web/portal/add/add-b.css?raw';
import addC from '../../web/portal/add/add-c.css?raw';
import phone from '../../web/portal/add/phone.css?raw';
import screens from '../../web/portal/add/phone-screens.css?raw';
import { ART_CSS } from '../../web/ui/art/css.ts';
import common from '../../web/ui/art/scenes/common.css?raw';
import nudge from '../../web/ui/art/scenes/nudge.css?raw';
import tear from '../../web/ui/art/scenes/tear.css?raw';

/**
 * /p's sheets for an exploration of the pass page (`?add=`, served from localhost only): the
 * shared grid and header, then the direction's own; c adds the buddy's art and its scenes.
 */
export const EXPLORE_CSS: Record<AddDirection, string> = {
  a: `${addCss}\n${addA}`,
  b: `${addCss}\n${addB}\n${phone}\n${screens}`,
  c: `${addCss}\n${addC}\n${ART_CSS}\n${common}\n${nudge}\n${tear}`,
};

/** Only a Worker serving localhost reads `?add=`; production never shows an exploration. */
export const explores = (baseUrl: string) => /^http:\/\/localhost(:\d+)?$/.test(baseUrl);
