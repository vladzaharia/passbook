import type { PDFImage } from 'pdf-lib';
import type { PaperDesign } from '../../../passkit/template/paper.ts';
import type { PaperContent } from '../../../passkit/template/paper-content.ts';
import type { PaperDrawing } from '../../../web/paper/drawing.ts';
import type { Issued } from '../../../web/paper/ticket-text.ts';

export interface PdfImages {
  logo?: PDFImage;
  art?: PDFImage;
}

/** One ticket, ready to draw: words, code drawing and embedded images. */
export interface Sheet {
  content: PaperContent;
  design: PaperDesign;
  code: string;
  drawing: PaperDrawing | undefined;
  issued?: Issued | undefined;
  mode?: 'live' | 'test' | undefined;
  images: PdfImages;
}
