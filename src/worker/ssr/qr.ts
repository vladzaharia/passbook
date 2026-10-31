import bwip from 'bwip-js/generic';

/** QR code as a data URI for an <img>, so the page needs neither inline SVG nor script. */
export function qrDataUri(text: string): string {
  const svg = bwip.toSVG({ bcid: 'qrcode', text, scale: 4, paddingwidth: 2, paddingheight: 2 });
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
