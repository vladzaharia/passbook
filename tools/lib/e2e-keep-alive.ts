import type { Plugin } from 'vite';

/**
 * e2e only. Node closes an idle keep-alive socket after 5 s plus a 1 s buffer. Playwright's request
 * context pools sockets, so a call that lands in the instant the server closes one fails with
 * `read ECONNRESET`; e2e/23's rolling-sheet test idles its API client about 6 s before its next GET.
 * Holding idle sockets far longer than any spec idles removes the race without touching a request timeout.
 */
export function e2eKeepAlive(): Plugin {
  const hold = (server: {
    httpServer: { keepAliveTimeout: number; headersTimeout: number } | null;
  }) => {
    if (!server.httpServer) return;
    server.httpServer.keepAliveTimeout = 120_000;
    server.httpServer.headersTimeout = 125_000;
  };
  return { name: 'e2e-keep-alive', configureServer: hold, configurePreviewServer: hold };
}
