import bwip from 'bwip-js/generic';
import { setBarcodeEngine } from './barcode-engine.ts';

/** Import for its side effect where rendering is synchronous (SSR, tests). */
setBarcodeEngine((options) => bwip.toSVG(options as unknown as Parameters<typeof bwip.toSVG>[0]));
