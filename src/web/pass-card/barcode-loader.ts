import { setBarcodeLoader } from './barcode-engine.ts';

/** Browser entry only: the encoders load on first use as their own chunk. */
setBarcodeLoader(() => import('../../shared/pass-view/barcode-svg.ts').then((mod) => mod.toSvg));
