import { parseSearchWith, stringifySearchWith } from '@tanstack/react-router';

// Integers past 2^53 lose digits in JSON.parse; an ID in a URL must come back as typed.
const UNSAFE_INT = /^-?\d{16,}$/;

function parseValue(value: string): unknown {
  return UNSAFE_INT.test(value) ? value : JSON.parse(value);
}

/** Router search codec: JSON values, but long numerals stay strings and are not quoted. */
export const parseSearch = parseSearchWith(parseValue);
export const stringifySearch = stringifySearchWith(JSON.stringify, (value) => {
  if (UNSAFE_INT.test(value)) throw new Error('kept as typed');
  return JSON.parse(value);
});
