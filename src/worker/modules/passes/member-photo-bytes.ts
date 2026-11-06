/** Keep pixel/color chunks only; API uploads must not carry names, GPS or camera metadata. */
export function memberPhotoPixels(png: Uint8Array): Uint8Array {
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM']);
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let offset = 8; offset + 12 <= png.length; ) {
    const size = view.getUint32(offset) + 12;
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (keep.has(type)) parts.push(png.subarray(offset, offset + size));
    offset += size;
  }
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
