/**
 * Minimal Home Assistant REST client that is read-only by construction.
 *
 * The only HTTP methods this client can send are:
 *   - GET  to any /api/* path
 *   - POST to /api/template (renders a Jinja template; cannot change state)
 *
 * Plus a small allowlist of read-only websocket commands (READ_ONLY_WS_COMMANDS).
 *
 * Anything else throws before a request is made. This is the safety boundary:
 * even if a tool is added carelessly later, it cannot call services, fire
 * events or write states through this client.
 */

const READ_ONLY_POST_PATHS = new Set(["/api/template"]);
const READ_ONLY_WS_COMMANDS = new Set(["system_log/list"]);

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

  /**
   * Run one read-only websocket command and return its result.
   * Opens a connection, authenticates, sends the command, closes.
   */
  async wsCommand<T = unknown>(type: string): Promise<T> {
    if (!READ_ONLY_WS_COMMANDS.has(type)) {
      throw new HAError(`Refusing websocket command '${type}' (not in read-only allowlist)`);
    }
    const url = this.baseUrl.replace(/^http/, "ws") + "/api/websocket";
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      const finish = (err: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve(value as T);
      };
      const timer = setTimeout(
        () => finish(new HAError(`Websocket timeout after ${this.timeoutMs}ms (${url})`)),
        this.timeoutMs,
      );
      ws.onerror = () => finish(new HAError(`Could not open websocket to ${url}`));
      ws.onclose = () => finish(new HAError("Websocket closed before a result was received"));
      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return finish(new HAError("Invalid websocket message from Home Assistant"));
        }
        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: this.token }));
        } else if (msg.type === "auth_invalid") {
          finish(new HAError("Websocket auth failed (check HA_TOKEN)", 401));
        } else if (msg.type === "auth_ok") {
          ws.send(JSON.stringify({ id: 1, type }));
        } else if (msg.type === "result" && msg.id === 1) {
          if (msg.success) finish(null, msg.result as T);
          else finish(new HAError(`Websocket command failed: ${msg.error?.message ?? "unknown error"}`));
        }
      };
    });
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
