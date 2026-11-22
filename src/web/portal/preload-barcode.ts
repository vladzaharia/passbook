import { loadBarcodeEngine } from '../pass-card/barcode-engine.ts';

// A pass's code is the page's focus: fetch the encoders as the route loads, beside the pass data,
// so the reserved box fills at once instead of after the first paint. A failure shows in the card.
loadBarcodeEngine().catch(() => {});
