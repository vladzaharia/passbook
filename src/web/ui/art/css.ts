import base from './art.css?raw';
import details from './art-details.css?raw';
import records from './art-records.css?raw';
import wallet from './art-wallet.css?raw';

/** Every art stylesheet in cascade order, for SSR pages to inline. */
export const ART_CSS = [base, records, details, wallet].join('\n');
