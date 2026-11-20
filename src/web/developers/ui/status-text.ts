const TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable',
  429: 'Too Many Requests',
  500: 'Server Error',
  502: 'Bad Gateway',
  503: 'Unavailable',
};

/** HTTP/2 sends no reason phrase, so the stamp brings its own. */
export const statusText = (status: number, given = ''): string =>
  `${status} ${TEXT[status] ?? (given || (status < 400 ? 'OK' : 'Error'))}`;
