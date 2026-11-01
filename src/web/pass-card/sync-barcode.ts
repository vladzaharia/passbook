import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { setBarcodeEngine } from './barcode-engine.ts';

/** Import for its side effect where rendering is synchronous (SSR, tests). */
setBarcodeEngine(toSvg);
