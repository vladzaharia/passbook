// Worker tests never reach the network. A test that needs fetch stubs globalThis.fetch itself
// (and restores it); anything else fails loudly instead of passing only while the internet is up.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  throw new Error(`Unmocked network call in test: ${url}`);
}) as typeof fetch;
