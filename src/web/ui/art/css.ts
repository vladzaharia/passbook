import base from './art.css?raw';
import details from './art-details.css?raw';
import records from './art-records.css?raw';
import wallet from './art-wallet.css?raw';
import hello from './scenes/hello.css?raw';
import rest from './scenes/rest.css?raw';

/**
 * Every art stylesheet in cascade order, for SSR pages to inline; then the buddy's rest sheet and
 * its hello scene (a click replays it: public/buddy-replay.js).
 */
export const ART_CSS = [base, records, details, wallet, rest, hello].join('\n');
