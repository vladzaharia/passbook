/** Freeze `value` and everything reachable through plain objects and arrays, once. */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const member of Object.values(value)) deepFreeze(member);
  return value;
}
