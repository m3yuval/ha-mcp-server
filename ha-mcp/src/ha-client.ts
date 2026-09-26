/**
 * Minimal Home Assistant REST client that is read-only by construction.
 *
 * The only HTTP methods this client can send are:
 *   - GET  to any /api/* path
 *   - POST to /api/template (renders a Jinja template; cannot change state)
 *
 * Anything else throws before a request is made. This is the safety boundary:
 * even if a tool is added carelessly later, it cannot call services, fire
 * events or write states through this client.
 */

const READ_ONLY_POST_PATHS = new Set(["/api/template"]);

export class HAError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export interface HAClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class HAClient {
  private baseUrl: string;
  private token: string;
  private timeoutMs: number;

  constructor(opts: HAClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  async get<T = unknown>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }

  /** Render a template. The only POST this client allows. */
  async renderTemplate(template: string): Promise<string> {
    return this.request<string>("POST", "/api/template", { template });
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    if (!path.startsWith("/api/")) {
      throw new HAError(`Refusing non-API path: ${path}`);
    }
    if (method === "POST" && !READ_ONLY_POST_PATHS.has(path)) {
      throw new HAError(`Refusing write request: POST ${path} (server is read-only)`);
    }

    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HAError(`Could not reach Home Assistant at ${this.baseUrl}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 401 ? " (check HA_TOKEN)" : res.status === 404 ? " (not found)" : "";
      throw new HAError(`Home Assistant returned ${res.status}${hint}: ${text.slice(0, 300)}`, res.status);
    }

    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      return JSON.parse(text) as T;
    }
    return text as T;
  }
}
