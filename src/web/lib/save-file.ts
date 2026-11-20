/** Hands a blob to the browser as a download; a plain link cannot carry Test mode's header. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Fetches a same-origin file with the console's mode and saves it. */
export async function saveFromApi(
  path: string,
  name: string,
  headers: Record<string, string>,
  failure: string,
): Promise<void> {
  const res = await fetch(path, { headers, credentials: 'same-origin' });
  if (!res.ok) throw new Error(failure);
  saveBlob(await res.blob(), name);
}
