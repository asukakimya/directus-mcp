import qs from 'qs';
import { McpUserError } from './errors.js';

export type DirectusRequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
};

/**
 * Thin wrapper over Directus REST API using global `fetch`.
 *
 * - Query params serialised with `qs` (brackets, encodeValuesOnly)
 *   so Directus receives arrays/objects exactly as intended.
 * - JSON body sent as-is (NOT stringified a second time).
 * - Non-2xx responses are converted into a `DirectusApiError`.
 */
export class DirectusRestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async request<T = unknown>(options: DirectusRequestOptions): Promise<T> {
    const normalizedBase = this.baseUrl.endsWith('/')
      ? this.baseUrl
      : `${this.baseUrl}/`;

    const url = new URL(options.path.replace(/^\/+/, ''), normalizedBase);

    if (options.query && Object.keys(options.query).length > 0) {
      const queryString = qs.stringify(options.query, {
        arrayFormat: 'brackets',
        encodeValuesOnly: true,
      });
      if (queryString) url.search = queryString;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    const text = await res.text();
    const parsed = text ? tryParseJson(text) : null;

    if (!res.ok) {
      throw new DirectusApiError({
        status: res.status,
        method: options.method ?? 'GET',
        url: url.toString(),
        response: parsed ?? text,
      });
    }

    return parsed as T;
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Error thrown when Directus API responds with non-2xx status.
 * It is converted into a `DIRECTUS_API_ERROR` McpUserError by tool handlers.
 */
export class DirectusApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly response: unknown;

  constructor(input: { status: number; method: string; url: string; response: unknown }) {
    super(`Directus API Error ${input.status} ${input.method} ${input.url}`);
    this.name = 'DirectusApiError';
    this.status = input.status;
    this.method = input.method;
    this.url = input.url;
    this.response = input.response;
  }

  toMcpError(): McpUserError {
    const apiErrors = extractDirectusErrors(this.response);
    return new McpUserError('DIRECTUS_API_ERROR', this.message, {
      status: this.status,
      method: this.method,
      url: this.url,
      response: this.response,
      apiErrors,
    });
  }
}

/**
 * Directus error responses typically look like:
 *   { errors: [{ message, extensions: { code } }] }
 * Pull them out so the LLM sees a cleaner message.
 */
function extractDirectusErrors(response: unknown): unknown {
  if (response && typeof response === 'object') {
    const r = response as { errors?: unknown };
    if (Array.isArray(r.errors)) {
      return r.errors;
    }
  }
  return undefined;
}
