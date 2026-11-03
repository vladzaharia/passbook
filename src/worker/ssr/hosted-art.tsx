/**
 * The hosted pages' art: the app's own React (web/ui/art/state-art.tsx) rendered to static markup,
 * seated on the card at the band's right. Its motion is CSS: the entrance and any acted scene play
 * once on load (data-run="load"), the idle beat at 2.4 s; public/buddy-replay.js replays the scene
 * or the hello on a click. HOSTED_ART_CSS follows ART_CSS.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { STATE_SCENE_CSS } from '../../web/ui/art/css.ts';
import { StateArt, type StateArtName } from '../../web/ui/art/state-art.tsx';
import band from './hosted-art.css?raw';

export const HOSTED_ART_CSS = `${STATE_SCENE_CSS}\n${band}`;

export type HostedArt = StateArtName;

/** A state's art as static markup; `failed` (a refused form) makes it sad. */
export function stateArtHtml(art: HostedArt, failed = false): string {
  return renderToStaticMarkup(<StateArt name={art} size="xl" failed={failed} playOnLoad />);
}
