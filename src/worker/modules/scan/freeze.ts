/**
 * Freeze `value` and everything reachable through own properties (symbol keys included), children
 * before parents, whether or not an object was frozen already. Functions and typed arrays are left.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): Readonly<T> {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (!ArrayBuffer.isView(value))
    for (const key of Reflect.ownKeys(value)) {
      const member = (value as Record<PropertyKey, unknown>)[key];
      if (member !== null && typeof member === 'object') deepFreeze(member, seen);
    }
  return Object.isFrozen(value) || ArrayBuffer.isView(value) ? value : Object.freeze(value);
}
