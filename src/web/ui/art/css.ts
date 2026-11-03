import base from './art.css?raw';
import details from './art-details.css?raw';
import records from './art-records.css?raw';
import wallet from './art-wallet.css?raw';
import common from './scenes/common.css?raw';
import hello from './scenes/hello.css?raw';
import mend from './scenes/mend.css?raw';
import peek from './scenes/peek.css?raw';
import plug from './scenes/plug.css?raw';
import rest from './scenes/rest.css?raw';
import tug from './scenes/tug.css?raw';
import states from './wallet-states.css?raw';

/**
 * Every art stylesheet in cascade order, for SSR pages to inline; then the buddy's rest sheet and
 * its hello scene (a click replays it: public/buddy-replay.js).
 */
export const ART_CSS = [base, records, details, wallet, states, rest, hello].join('\n');

/** The scenes SSR state pages act out (state-art.tsx): error, not found, forbidden. */
export const STATE_SCENE_CSS = [common, plug, peek, mend, tug].join('\n');
