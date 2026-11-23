/**
 * A PEM block for tests that exercise PEM handling, assembled from parts so no key-shaped text sits in the source
 * (secret scanners match a whole header). The body is whatever the test needs: invalid, or real from a fixture.
 */
export const pemBlock = (label: string, body = 'abc'): string =>
  `-----${'BEGIN'} ${label}-----\n${body}\n-----${'END'} ${label}-----`;
