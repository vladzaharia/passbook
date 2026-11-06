/** Browser decode, centre crop and re-encode: no original image metadata is uploaded. */
export async function memberPhotoPng(file: File): Promise<string> {
  if (!file.type.startsWith('image/') || file.size > 10_000_000)
    throw new Error('Choose an image smaller than 10 MB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error('The photo could not be read; choose another image.');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 270;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The photo could not be prepared; try another browser.');
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      270,
      270,
    );
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  } finally {
    URL.revokeObjectURL(url);
  }
}
