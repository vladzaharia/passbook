/** A developer-site link comes back to it: only its own paths, never another site. */
export function returnTarget(value: string | undefined): string | undefined {
  return (value?.startsWith('/developers/') || value?.startsWith('/workbench/')) &&
    !value.startsWith('//')
    ? value
    : undefined;
}

/** Where the finish goes: the Workbench selects an endpoint by hash, the docs by `?endpoint=`. */
export const comeBack = (back: string, id: string) =>
  back.startsWith('/workbench/')
    ? `${back}#${id}`
    : `${back}${back.includes('?') ? '&' : '?'}endpoint=${id}`;
