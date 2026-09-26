/**
 * Home Assistant + Supervisor client with capability gates.
 *
 * Safety model:
 *   - Reads are always allowed: GET /api/*, POST /api/template (render only),
 *     and the READ_ONLY_WS_COMMANDS websocket allowlist.
 *   - Every other request must name a capability ("actions" | "config" |
 *     "management"). If that capability is not enabled in the add-on options,
 *     the request throws BEFORE anything is sent.
 *   - Service calls always enforce BLOCKED_DOMAINS, including entities reached
 *     indirectly through area/device/floor/label targets.
 *
 * Tool modules must go through this client; they must not call fetch() or open
 * websockets themselves, so these gates can't be bypassed.
 */
import type { Capability } from "./config.js";
import { log, summarize } from "./logger.js";

const READ_ONLY_POST_PATHS = new Set(["/api/template"]);

/** Websocket commands that only read state. Allowed without any capability. */
export const READ_ONLY_WS_COMMANDS = new Set([
  "system_log/list",
  "get_config",
  "get_services",
  "get_states",
  "config_entries/get",
  "config_entries/flow/progress",
  "config/area_registry/list",
  "config/device_registry/list",
  "config/entity_registry/list",
  "config/entity_registry/list_for_display",
  "config/entity_registry/get",
  "config/entity_registry/get_entries",
  "config/floor_registry/list",
  "config/label_registry/list",
  "config/category_registry/list",
  "manifest/list",
  "manifest/get",
  "integration/descriptions",
  "search/related",
  "repairs/list_issues",
  "recorder/info",
  "auth/current_user",
  "homeassistant/expose_entity/list",
]);

export class HAError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export interface HAClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  capabilities?: Iterable<Capability>;
  blockedDomains?: Iterable<string>;
  supervisorUrl?: string;
  supervisorToken?: string;
}

export interface ServiceCallOptions {
  data?: Record<string, unknown>;
  target?: {
    entity_id?: string | string[];
    device_id?: string | string[];
    area_id?: string | string[];
    floor_id?: string | string[];
    label_id?: string | string[];
  };
  returnResponse?: boolean;
}

type Method = "GET" | "POST" | "DELETE" | "PUT" | "PATCH";

function toArray(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

export class HAClient {
  readonly baseUrl: string;
  private token: string;
  private timeoutMs: number;
  private caps: Set<Capability>;
  readonly blockedDomains: Set<string>;
  private supervisorUrl?: string;
  private supervisorToken?: string;

  constructor(opts: HAClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.caps = new Set<Capability>(opts.capabilities ?? ["read"]);
    this.caps.add("read");
    this.blockedDomains = new Set([...(opts.blockedDomains ?? [])].map((d) => d.toLowerCase()));
    this.supervisorUrl = opts.supervisorUrl?.replace(/\/+$/, "");
    this.supervisorToken = opts.supervisorToken;
  }

  has(cap: Capability): boolean {
    return this.caps.has(cap);
  }

  get hasSupervisor(): boolean {
    return Boolean(this.supervisorUrl && this.supervisorToken);
  }

  private requireCap(cap: Capability, what: string) {
    if (cap === "read") {
      throw new HAError(`Refusing write request: ${what} (a non-read capability is required)`);
    }
    if (!this.caps.has(cap)) {
      throw new HAError(
        `Refusing ${what}: the '${cap}' capability is disabled. Enable it in the add-on configuration.`,
      );
    }
  }

  // ---------------------------------------------------------------- reads

  async get<T = unknown>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    return this.rest<T>("GET", path, undefined, query);
  }

  /** Render a template. Read-only. */
  async renderTemplate(template: string): Promise<string> {
    return this.rest<string>("POST", "/api/template", { template });
  }

  /** Run a read-only websocket command (must be in READ_ONLY_WS_COMMANDS). */
  async wsRead<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (!READ_ONLY_WS_COMMANDS.has(type)) {
      throw new HAError(`Refusing websocket command '${type}' (not in read-only allowlist)`);
    }
    return this.wsRaw<T>(type, payload);
  }

  /** Back-compat alias used by read tools. */
  async wsCommand<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    return this.wsRead<T>(type, payload);
  }

  // --------------------------------------------------------------- writes

  async post<T = unknown>(path: string, body: unknown, cap: Capability): Promise<T> {
    this.requireCap(cap, `POST ${path}`);
    if (path.startsWith("/api/services/")) {
      throw new HAError("Use callService() for service calls so blocked domains are enforced");
    }
    return this.rest<T>("POST", path, body);
  }

  async delete<T = unknown>(path: string, cap: Capability): Promise<T> {
    this.requireCap(cap, `DELETE ${path}`);
    return this.rest<T>("DELETE", path);
  }

  /** Any websocket command, gated by capability. */
  async ws<T = unknown>(type: string, payload: Record<string, unknown>, cap: Capability): Promise<T> {
    if (READ_ONLY_WS_COMMANDS.has(type)) return this.wsRaw<T>(type, payload);
    this.requireCap(cap, `websocket command '${type}'`);
    if (type === "call_service") {
      throw new HAError("Use callService() for service calls so blocked domains are enforced");
    }
    return this.wsRaw<T>(type, payload);
  }

  /**
   * Call a service (action). Enforces blocked domains on the service domain and
   * on every entity the call targets, including via area/device/floor/label.
   */
  async callService<T = unknown>(
    domain: string,
    service: string,
    opts: ServiceCallOptions,
    cap: Capability,
  ): Promise<T> {
    this.requireCap(cap, `service call ${domain}.${service}`);
    if (!/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(service)) {
      throw new HAError(`Invalid service name '${domain}.${service}'`);
    }
    await this.assertNotBlocked(domain, opts);
    const body: Record<string, unknown> = { ...(opts.data ?? {}) };
    if (opts.target) {
      for (const [k, v] of Object.entries(opts.target)) {
        if (v !== undefined) body[k] = v;
      }
    }
    const query = opts.returnResponse ? "?return_response" : "";
    return this.rest<T>("POST", `/api/services/${domain}/${service}${query}`, body);
  }

  /** Throws if the call touches a blocked domain. */
  async assertNotBlocked(domain: string, opts: ServiceCallOptions = {}) {
    if (this.blockedDomains.size === 0) return;
    if (this.blockedDomains.has(domain.toLowerCase())) {
      throw new HAError(`Domain '${domain}' is blocked by the add-on configuration (blocked_domains)`);
    }
    const t = opts.target ?? {};
    const d = opts.data ?? {};
    const entities = [...toArray(t.entity_id), ...toArray(d.entity_id)];
    const indirect = {
      areas: [...toArray(t.area_id), ...toArray(d.area_id)],
      devices: [...toArray(t.device_id), ...toArray(d.device_id)],
      floors: [...toArray(t.floor_id), ...toArray(d.floor_id)],
      labels: [...toArray(t.label_id), ...toArray(d.label_id)],
    };
    if (entities.some((e) => e.toLowerCase() === "all")) {
      throw new HAError("entity_id 'all' is not allowed while blocked_domains is set");
    }
    if (Object.values(indirect).some((l) => l.length)) {
      const tpl =
        `{% set ns = namespace(e=[]) %}` +
        `{% for a in ${JSON.stringify(indirect.areas)} %}{% set ns.e = ns.e + area_entities(a) %}{% endfor %}` +
        `{% for f in ${JSON.stringify(indirect.floors)} %}{% for a in floor_areas(f) %}{% set ns.e = ns.e + area_entities(a) %}{% endfor %}{% endfor %}` +
        `{% for dv in ${JSON.stringify(indirect.devices)} %}{% set ns.e = ns.e + device_entities(dv) %}{% endfor %}` +
        `{% for l in ${JSON.stringify(indirect.labels)} %}{% set ns.e = ns.e + label_entities(l) %}{% endfor %}` +
        `{{ ns.e | tojson }}`;
      const raw = await this.renderTemplate(tpl);
      entities.push(...(JSON.parse(String(raw)) as string[]));
    }
    const hit = entities.filter((e) => this.blockedDomains.has(e.split(".")[0].toLowerCase()));
    if (hit.length) {
      throw new HAError(
        `Refusing: the call targets blocked entities (${[...new Set(hit)].slice(0, 10).join(", ")}). ` +
          `Blocked domains: ${[...this.blockedDomains].join(", ")}`,
      );
    }
  }

  // ----------------------------------------------------------- supervisor

  /** Supervisor API. GETs need 'management' too (they expose host details). */
  async supervisor<T = unknown>(method: Method, path: string, body?: unknown): Promise<T> {
    if (!this.caps.has("management")) {
      throw new HAError("Refusing Supervisor request: the 'management' capability is disabled.");
    }
    if (!this.supervisorUrl || !this.supervisorToken) {
      throw new HAError("Supervisor API is not available (only when running as a Home Assistant add-on).");
    }
    if (!path.startsWith("/")) throw new HAError(`Invalid Supervisor path: ${path}`);
    const res = await this.fetchJson(method, this.supervisorUrl + path, this.supervisorToken, body);
    // Supervisor wraps responses: { result: "ok" | "error", data, message }
    if (res && typeof res === "object" && "result" in (res as any)) {
      const r = res as { result: string; data?: unknown; message?: string };
      if (r.result !== "ok") throw new HAError(`Supervisor error: ${r.message ?? "unknown"}`);
      return r.data as T;
    }
    return res as T;
  }

  // ------------------------------------------------------------ internals

  private async rest<T>(
    method: Method,
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    if (!path.startsWith("/api/")) {
      throw new HAError(`Refusing non-API path: ${path}`);
    }
    const basePath = path.split("?")[0];
    if (method !== "GET" && !READ_ONLY_POST_PATHS.has(basePath)) {
      // Writes only reach here via post()/delete()/callService(), which check caps.
      // This second check stops any future code path that forgets to.
      const writeCaps: Capability[] = ["actions", "config", "management"];
      if (!writeCaps.some((c) => this.caps.has(c))) {
        throw new HAError(`Refusing write request: ${method} ${path} (server is read-only)`);
      }
    }
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
    return this.fetchJson<T>(method, url.toString(), this.token, body);
  }

  private async fetchJson<T>(method: Method, url: string, token: string, body?: unknown): Promise<T> {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const safeUrl = url.replace(/^https?:\/\/[^/]+/, "");
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug(`HA ${method} ${safeUrl} failed: ${msg}`);
      throw new HAError(`Could not reach ${safeUrl}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    log.debug(`HA ${method} ${safeUrl} -> ${res.status} (${Date.now() - started}ms)`);
    if (!res.ok) {
      const hint = res.status === 401 ? " (check the token)" : res.status === 404 ? " (not found)" : "";
      throw new HAError(`Home Assistant returned ${res.status}${hint}: ${text.slice(0, 300)}`, res.status);
    }
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) return (text ? JSON.parse(text) : null) as T;
    return text as T;
  }

  /** Open a websocket, authenticate, run one command, close. */
  private wsRaw<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    const url = this.baseUrl.replace(/^http/, "ws") + "/api/websocket";
    const started = Date.now();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      const finish = (err: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        log.debug(`HA ws ${type} ${summarize(payload, 150)} -> ${err ? "error" : "ok"} (${Date.now() - started}ms)`);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve(value as T);
      };
      const timer = setTimeout(() => finish(new HAError(`Websocket timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
      ws.onerror = () => finish(new HAError(`Could not open websocket to Home Assistant`));
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
          finish(new HAError("Websocket auth failed (check the token)", 401));
        } else if (msg.type === "auth_ok") {
          ws.send(JSON.stringify({ ...payload, id: 1, type }));
        } else if (msg.type === "result" && msg.id === 1) {
          if (msg.success) finish(null, msg.result as T);
          else finish(new HAError(`Websocket command '${type}' failed: ${msg.error?.message ?? "unknown error"}`));
        }
      };
    });
  }
}
