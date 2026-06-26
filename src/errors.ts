/**
 * Mirror of the canonical `ApiError` from `@aether/api-client`
 * (packages/api-client/src/errors.ts), trimmed to the surface this
 * reproduction needs. The transport throws one of these on any non-2xx
 * response, network error, timeout, or caller cancellation.
 *
 * The production Sentry event (WEB-SZ) is an `ApiError` with
 * message "Failed to connect workspace" and status 500 — i.e. the server's
 * 500 response body `{ "message": "Failed to connect workspace" }` surfaced
 * verbatim by the transport.
 */

export interface ApiErrorInit {
  message: string;
  status: number;
  code?: string | undefined;
  body?: unknown;
  method: string;
  path: string;
  operation: string;
  area: string;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string | undefined;
  readonly body?: unknown;
  readonly method: string;
  readonly path: string;
  readonly operation: string;
  readonly area: string;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.body = init.body;
    this.method = init.method;
    this.path = init.path;
    this.operation = init.operation;
    this.area = init.area;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isServerError(): boolean {
    return this.status >= 500;
  }
}

/** Network-level failure (DNS, connection refused, TLS). status === 0. */
export class NetworkError extends ApiError {
  constructor(init: Omit<ApiErrorInit, "status">) {
    super({ ...init, status: 0 });
    this.name = "NetworkError";
  }
}

/** Timeout expired before a response. status === -1. */
export class TimeoutError extends ApiError {
  constructor(init: Omit<ApiErrorInit, "status">) {
    super({ ...init, status: -1 });
    this.name = "TimeoutError";
  }
}

/**
 * Caller's AbortSignal aborted the request. status === -2.
 * User-initiated cancellation — never reported to telemetry.
 */
export class CancelledError extends ApiError {
  constructor(init: Omit<ApiErrorInit, "status">) {
    super({ ...init, status: -2 });
    this.name = "CancelledError";
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isCancelledError(value: unknown): value is CancelledError {
  return value instanceof CancelledError;
}
