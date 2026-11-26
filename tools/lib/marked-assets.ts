/**
 * A lazy chunk found by a literal only it carries (`wb-shell`), with every chunk it imports
 * statically and the stylesheets that carry the literal too (`.wb-shell`), minus the initial load.
 * `files` are `/assets/x` urls; more than one script carrying the literal is an error.
 */
export function markedAssets(
  read: (url: string) => string,
  files: readonly string[],
  initial: readonly string[],
  marker: string,
): { files: string[]; errors: string[] } {
  const skip = new Set(initial);
  const scripts = files.filter(
    (f) => f.endsWith('.js') && !skip.has(f) && read(f).includes(marker),
  );
  if (scripts.length !== 1)
    return {
      files: [],
      errors: [`${marker}: ${scripts.length} chunks carry it (${scripts.join(', ')}), want 1`],
    };
  const seen = new Set<string>();
  const walk = (url: string) => {
    if (seen.has(url) || skip.has(url)) return;
    seen.add(url);
    for (const m of read(url).matchAll(/(?:from|import)\s*"\.\/([\w.-]+\.js)"/g))
      walk(`/assets/${m[1]}`);
  };
  walk(scripts[0] as string);
  for (const f of files) if (f.endsWith('.css') && read(f).includes(`.${marker}`)) seen.add(f);
  return { files: [...seen], errors: [] };
}
