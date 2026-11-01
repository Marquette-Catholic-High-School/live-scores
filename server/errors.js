// HTTP-facing errors. Anything thrown from a route handler that is not an
// HttpError is reported as 500 `internal` (and logged with its stack).

export class HttpError extends Error {
  constructor(status, code, message, { retryAfterSec, headers } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.headers = headers;
  }
}

export const badRequest = (message) => new HttpError(400, 'bad_request', message);
export const unauthorized = (message = 'Sign in required.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You are not allowed to do that.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const conflict = (message) => new HttpError(409, 'conflict', message);
export const tooEarly = (message) => new HttpError(409, 'too_early', message);
export const rateLimited = (message, retryAfterSec) =>
  new HttpError(429, 'rate_limited', message, { retryAfterSec: Math.max(1, Math.ceil(retryAfterSec ?? 60)) });
