import type { PaperDesign } from '../../../passkit/template/paper.ts';
import type { PaperContent } from '../../../passkit/template/paper-content.ts';
import type { BrandMark } from '../../../shared/contracts/orgs.ts';
import type { PaperDrawing } from '../../../web/paper/drawing.ts';
import type { Issued } from '../../../web/paper/ticket-text.ts';
import type { PdfPicture } from './pdf-png.ts';

export interface PdfImages {
  logo?: PdfPicture;
  art?: PdfPicture;
}

/** One ticket, ready to draw: words, code drawing and embedded images. */
export interface Sheet {
  content: PaperContent;
  design: PaperDesign;
  code: string;
  drawing: PaperDrawing | undefined;
  issued?: Issued | undefined;
  mark: BrandMark;
  mode?: 'live' | 'test' | undefined;
  images: PdfImages;
}
