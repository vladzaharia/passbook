import type { Server } from 'node:http';
import type { Plugin } from 'vite';

/**
 * e2e only. Node closes an idle keep-alive socket after 5 s plus a 1 s buffer. Playwright's request
 * context pools sockets, so a call that lands in the instant the server closes one fails with
 * `read ECONNRESET`; e2e/23's rolling-sheet test idles its API client about 6 s before its next GET.
 * Holding idle sockets far longer than any spec idles removes the race without touching a request timeout.
 */
export function e2eKeepAlive(): Plugin {
  // The dev and preview servers are plain HTTP here; the type also allows HTTP/2, which has neither field.
  const hold = (server: { httpServer: unknown }) => {
    const http = server.httpServer as Server | null;
    if (!http) return;
    http.keepAliveTimeout = 120_000;
    http.headersTimeout = 125_000;
  };
  return { name: 'e2e-keep-alive', configureServer: hold, configurePreviewServer: hold };
}
