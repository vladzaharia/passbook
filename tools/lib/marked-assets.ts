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
  const seen = staticClosure(read, scripts[0] as string, skip);
  for (const f of files) if (f.endsWith('.css') && read(f).includes(`.${marker}`)) seen.add(f);
  return { files: [...seen], errors: [] };
}

/** The chunk and everything it imports statically (`from"./x.js"`), minus `skip`. */
function staticClosure(
  read: (url: string) => string,
  chunk: string,
  skip: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const walk = (url: string) => {
    if (seen.has(url) || skip.has(url)) return;
    seen.add(url);
    for (const m of read(url).matchAll(/(?:from|import)\s*"\.\/([\w.-]+\.js)"/g))
      walk(`/assets/${m[1]}`);
  };
  walk(chunk);
  return seen;
}

/**
 * A shared chunk the build names itself (`wb-bench-<hash>.js`, the `codeSplitting` groups in
 * vite.config.ts), with every chunk it imports statically and its stylesheet (`wb-bench-<hash>.css`),
 * minus the initial load. Exactly one script carries the name.
 */
export function namedAssets(
  read: (url: string) => string,
  files: readonly string[],
  initial: readonly string[],
  name: string,
): { files: string[]; errors: string[] } {
  const skip = new Set(initial);
  const scripts = files.filter((f) => new RegExp(`^/assets/${name}-[\\w-]+\\.js$`).test(f));
  if (scripts.length !== 1)
    return {
      files: [],
      errors: [`${name}: ${scripts.length} chunks are named so (${scripts.join(', ')}), want 1`],
    };
  const seen = staticClosure(read, scripts[0] as string, skip);
  for (const f of files)
    if (new RegExp(`^/assets/${name}-[\\w-]+\\.css$`).test(f) && !skip.has(f)) seen.add(f);
  return { files: [...seen], errors: [] };
}
