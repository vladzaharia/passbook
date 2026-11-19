// The router's current pathname, for modules outside React (mode headers, legacy links).
let read: () => string | undefined = () => undefined;

/** router.tsx hands over the router's location. */
export function trackCurrentPath(next: () => string): void {
  read = next;
}

export const currentPath = (): string | undefined => read();
