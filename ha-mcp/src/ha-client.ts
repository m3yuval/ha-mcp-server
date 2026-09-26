/**
 * Home Assistant + Supervisor client with capability gates.
 *
 * Safety model:
 *   - Reads are always allowed: GET /api/*, POST /api/template (render only),
 *     and the READ_ONLY_WS_COMMANDS websocket allowlist.
 *   - Every other request must name a capability ("actions" | "config" |
 *     "management"). If that capability is not enabled in the add-on options,
 *     the request throws BEFORE anything is sent.
 *   - System-level actions (SYSTEM_SERVICES: restart/stop, hassio.*, update.*,
 *     backup.*, recorder.*, logger.*, reloads, ...) are never reachable with
 *     'actions'; reloads need 'config', the rest 'management'.
 *   - Service calls always enforce BLOCKED_DOMAINS, including entities reached
 *     indirectly through area/device/floor/label/group targets and entity ids
 *     mentioned in the data. See BLOCKED_DOMAINS_LIMITS for what it can't cover.
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

/**
 * What blocked_domains can and cannot guarantee. Exported so docs and tool
 * descriptions can reuse the exact wording.
 */
export const BLOCKED_DOMAINS_LIMITS =
  "blocked_domains stops this server from calling actions on entities in those domains, including entities reached " +
  "through area, floor, device and label targets, old-style group.* members, and entity ids mentioned anywhere in the " +
  "action data. While it is set, registry ids (UUIDs) and 'all' are refused as targets, and so are scene.apply, " +
  "scene.create, group.set, the intent API, and Assist when Assist can reach a blocked entity. It cannot see what " +
  "Home Assistant does on its own afterwards: scripts, automations and scenes that act on blocked entities internally; " +
  "input helpers, counters, timers, buttons or events that trigger such automations; integrations that run commands or " +
  "send raw messages (python_script, shell_command, rest_command, command_line, pyscript, mqtt.publish, " +
  "remote.send_command, zha / zwave_js / esphome services and similar). Treat it as a guard rail against mistakes, not " +
  "a security boundary: for real isolation, don't wire those devices to anything the assistant can trigger.";

/** Keys that Home Assistant treats as action targets, both in 'target' and in the data. */
export const TARGET_KEYS = ["entity_id", "device_id", "area_id", "floor_id", "label_id"] as const;

const ENTITY_ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/**
 * System-level actions. They are refused when called with the 'actions'
 * capability (ha_call_service and every device-control tool) and are only
 * reachable from the dedicated config / management tools.
 *   "domain.*"                  every action of that domain
 *   "*.reload", "*.reload_*"    reload actions of any domain (config level)
 *   "domain.name"               one action
 */
export const SYSTEM_SERVICES = [
  "hassio.*",
  "homeassistant.*",
  "update.*",
  "backup.*",
  "recorder.*",
  "logger.*",
  "system_log.*",
  "cloud.*",
  "*.reload",
  "*.reload_*",
] as const;

/** Exceptions to SYSTEM_SERVICES: ordinary device control through homeassistant.* */
export const SYSTEM_SERVICE_EXCEPTIONS = new Set([
  "homeassistant.turn_on",
  "homeassistant.turn_off",
  "homeassistant.toggle",
  "homeassistant.update_entity",
]);

/**
 * Which capability a system-level action needs, or null for ordinary actions.
 * Reloads need 'config' (or 'management'); everything else in SYSTEM_SERVICES
 * needs 'management'.
 */
export function systemServiceLevel(domain: string, service: string): "config" | "management" | null {
  if (SYSTEM_SERVICE_EXCEPTIONS.has(`${domain}.${service}`)) return null;
  const matched = SYSTEM_SERVICES.some((p) => {
    const [pd, ps] = p.split(".");
    const domOk = pd === "*" || pd === domain;
    const svcOk = ps === "*" || (ps.endsWith("*") ? service.startsWith(ps.slice(0, -1)) : ps === service);
    return domOk && svcOk;
  });
  if (!matched) return null;
  return service === "reload" || service.startsWith("reload_") ? "config" : "management";
}

/** Actions that can reach arbitrary entities in ways we can't check; refused while blocked_domains is set. */
const REFUSED_WHILE_BLOCKED = new Set(["scene.apply", "scene.create", "group.set"]);
/** Websocket commands that act without a checkable target; refused while blocked_domains is set. */
const WS_REFUSED_WHILE_BLOCKED = new Set(["execute_script", "fire_event", "intent/handle"]);
/** Websocket commands that run Assist; allowed only if Assist can't reach a blocked entity. */
const WS_ASSIST_COMMANDS = new Set(["conversation/process", "assist_pipeline/run"]);

export class HAError extends Error {
  /** Websocket error code from Home Assistant, when there is one (e.g. 'template_error'). */
  code?: string;
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

  /**
   * Render a user-supplied template with a time limit, via the websocket
   * render_template command. POST /api/template has no timeout, so a template
   * such as nested range(100000) loops would block Home Assistant's event loop.
   * HA answers with a result (the subscription started, or an error such as
   * "Exceeded maximum execution time") and then an event carrying {result} or
   * {error, level}. Closing the socket ends the subscription. Read-only.
   */
  async renderTemplateWithTimeout(template: string, timeoutSeconds = 3): Promise<unknown> {
    const timeout = Math.min(Math.max(timeoutSeconds, 0.1), 10);
    const warnings: string[] = [];
    return this.wsRaw<unknown>(
      "render_template",
      { template, timeout, report_errors: true, strict: false },
      {
        timeoutMs: Math.min(this.timeoutMs, timeout * 1000 + 5000),
        onEvent: (ev: any) => {
          if (ev && typeof ev === "object" && "result" in ev) {
            return { done: true, value: warnings.length ? { result: ev.result, warnings } : ev.result };
          }
          if (ev && typeof ev === "object" && "error" in ev) {
            if (String(ev.level ?? "ERROR").toUpperCase() === "ERROR") {
              return { done: true, error: new HAError(`Template error: ${ev.error}`) };
            }
            warnings.push(String(ev.error));
          }
          return { done: false };
        },
      },
    );
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
    const basePath = path.split("?")[0];
    if (this.blockedDomains.size) {
      if (basePath === "/api/intent/handle") {
        throw new HAError("Refusing the intent API while blocked_domains is set (intents are not limited to exposed entities).");
      }
      if (basePath === "/api/conversation/process") await this.assertAssistSafe();
      if (basePath.startsWith("/api/events/")) {
        await this.assertNotBlocked(null, { data: (body ?? {}) as Record<string, unknown> });
      }
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
    if (this.blockedDomains.size) {
      if (WS_REFUSED_WHILE_BLOCKED.has(type)) {
        throw new HAError(`Refusing websocket command '${type}' while blocked_domains is set (its targets can't be checked).`);
      }
      if (WS_ASSIST_COMMANDS.has(type)) await this.assertAssistSafe();
    }
    return this.wsRaw<T>(type, payload);
  }

  /**
   * Call a service (action). Enforces:
   *   - the capability, and SYSTEM_SERVICES: system-level actions are never
   *     reachable with 'actions'; reloads need 'config', the rest 'management';
   *   - blocked domains on the service domain and on every entity the call
   *     targets, including via area/device/floor/label/group (assertNotBlocked).
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
    this.assertServiceAllowedFor(domain, service, cap);
    await this.assertNotBlocked(domain, opts, service);
    const body: Record<string, unknown> = { ...(opts.data ?? {}) };
    if (opts.target) {
      for (const [k, v] of Object.entries(opts.target)) {
        if (v !== undefined) body[k] = v;
      }
    }
    const query = opts.returnResponse ? "?return_response" : "";
    return this.rest<T>("POST", `/api/services/${domain}/${service}${query}`, body);
  }

  /** Throws if a system-level action is called with a capability that may not reach it. */
  assertServiceAllowedFor(domain: string, service: string, cap: Capability) {
    const level = systemServiceLevel(domain, service);
    if (!level) return;
    if (cap === "management" || (level === "config" && cap === "config")) return;
    const need =
      level === "config"
        ? "the 'enable_config_files' (or 'enable_management') switch and the ha_reload_config tool"
        : "the 'enable_management' switch and the matching management tool (e.g. ha_restart, ha_install_update, ha_set_log_level, ha_purge_recorder, the backup and add-on tools)";
    throw new HAError(
      `Refusing ${domain}.${service}: it is a system-level action and is not available through the '${cap}' capability. ` +
        `It needs ${need}.`,
    );
  }

  /**
   * Throws unless Assist is safe to use with blocked_domains set: no entity in
   * a blocked domain may be exposed to the conversation assistant.
   */
  async assertAssistSafe() {
    if (this.blockedDomains.size === 0) return;
    let exposed: Record<string, Record<string, boolean>>;
    try {
      const res = await this.wsRaw<{ exposed_entities?: Record<string, Record<string, boolean>> }>(
        "homeassistant/expose_entity/list",
        {},
      );
      exposed = res?.exposed_entities ?? {};
    } catch (err) {
      throw new HAError(
        `Refusing: blocked_domains is set and the entities exposed to Assist could not be checked (${err instanceof Error ? err.message : err}).`,
      );
    }
    const hit = Object.entries(exposed)
      .filter(([id, a]) => a?.conversation === true && this.blockedDomains.has(id.split(".")[0].toLowerCase()))
      .map(([id]) => id);
    if (hit.length) {
      throw new HAError(
        `Refusing: Assist can control entities in blocked domains (${hit.slice(0, 10).join(", ")}). ` +
          "Un-expose them in Settings → Voice assistants → Expose, or use the specific ha_* tools.",
      );
    }
  }

  /**
   * Throws if a call could touch a blocked domain. `domain` is the action's
   * domain (null for events); `service` the action name, when known.
   *
   * - Entity values from target AND data are read the way Home Assistant reads
   *   them: comma separated, trimmed, lower case. While blocked_domains is set,
   *   'all' and anything that isn't a plain entity id (e.g. an entity-registry
   *   UUID, which HA also accepts) are refused.
   * - Area / floor / device / label targets and old-style group.* entities are
   *   expanded with a template, like homeassistant/helpers/target.py: a label
   *   reaches labelled entities, labelled devices' entities and labelled
   *   areas' entities; groups are expanded with expand().
   * - Every string in the data (keys and values, deep) is scanned for
   *   '<blocked_domain>.<object_id>'.
   * - scene.apply / scene.create / group.set are refused and conversation.process
   *   needs Assist to be unable to reach blocked entities.
   *
   * This is a guard rail, not a sandbox: see BLOCKED_DOMAINS_LIMITS for what it
   * cannot see (scripts/automations/scenes acting internally, helpers or events
   * that trigger automations, command-running integrations, ...).
   */
  async assertNotBlocked(domain: string | null, opts: ServiceCallOptions = {}, service?: string) {
    if (this.blockedDomains.size === 0) return;
    const blockedList = [...this.blockedDomains].join(", ");
    if (domain && this.blockedDomains.has(domain.toLowerCase())) {
      throw new HAError(`Domain '${domain}' is blocked by the add-on configuration (blocked_domains)`);
    }
    if (domain && service) {
      const full = `${domain}.${service}`.toLowerCase();
      if (REFUSED_WHILE_BLOCKED.has(full)) {
        throw new HAError(
          `Refusing ${full} while blocked_domains is set: it can act on any entity in ways that can't be checked. Blocked domains: ${blockedList}`,
        );
      }
      if (full === "conversation.process") await this.assertAssistSafe();
    }
    const t = (opts.target ?? {}) as Record<string, unknown>;
    const d = (opts.data ?? {}) as Record<string, unknown>;

    const entities: string[] = [];
    for (const raw of [...toArray(t.entity_id), ...toArray(d.entity_id)]) {
      for (const part of raw.split(",")) {
        const e = part.trim().toLowerCase();
        if (e) entities.push(e);
      }
    }
    if (entities.includes("all")) {
      throw new HAError("entity_id 'all' is not allowed while blocked_domains is set");
    }
    const direct = entities.filter((e) => e !== "none");
    const invalid = direct.filter((e) => !ENTITY_ID_RE.test(e));
    if (invalid.length) {
      throw new HAError(
        `Refusing: '${invalid.slice(0, 5).join("', '")}' is not a plain entity id (domain.object_id). ` +
          "While blocked_domains is set, entity targets must be entity ids like 'light.kitchen' (registry ids are not accepted).",
      );
    }
    const ids = (k: string) => [...toArray(t[k]), ...toArray(d[k])].map((v) => v.trim()).filter(Boolean);
    const indirect = { areas: ids("area_id"), devices: ids("device_id"), floors: ids("floor_id"), labels: ids("label_id") };
    const reached = [...direct];
    const needsExpansion = Object.values(indirect).some((l) => l.length) || direct.some((e) => e.startsWith("group."));
    if (needsExpansion) {
      const j = JSON.stringify;
      const tpl =
        `{% set ns = namespace(e=[]) %}` +
        `{% for a in ${j(indirect.areas)} %}{% set ns.e = ns.e + area_entities(a) %}{% endfor %}` +
        `{% for f in ${j(indirect.floors)} %}{% for a in floor_areas(f) %}{% set ns.e = ns.e + area_entities(a) %}{% endfor %}{% endfor %}` +
        `{% for dv in ${j(indirect.devices)} %}{% set ns.e = ns.e + device_entities(dv) %}{% endfor %}` +
        `{% for l in ${j(indirect.labels)} %}{% set ns.e = ns.e + label_entities(l) %}` +
        `{% for dv in label_devices(l) %}{% set ns.e = ns.e + device_entities(dv) %}{% endfor %}` +
        `{% for a in label_areas(l) %}{% set ns.e = ns.e + area_entities(a) %}{% endfor %}{% endfor %}` +
        `{% set ns.e = ns.e + ${j(direct)} %}` +
        `{{ (ns.e + (expand(ns.e) | map(attribute='entity_id') | list)) | unique | list | tojson }}`;
      const raw = await this.renderTemplate(tpl);
      let expanded: unknown;
      try {
        expanded = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        expanded = undefined;
      }
      if (!Array.isArray(expanded)) {
        throw new HAError(`Refusing: could not expand the call's targets to check blocked_domains (${String(raw).slice(0, 200)})`);
      }
      reached.push(...expanded.map((e) => String(e).toLowerCase()));
    }
    const hit = reached.filter((e) => this.blockedDomains.has(e.split(".")[0]));
    if (hit.length) {
      throw new HAError(
        `Refusing: the call targets blocked entities (${[...new Set(hit)].slice(0, 10).join(", ")}). ` +
          `Blocked domains: ${blockedList}`,
      );
    }
    const mentioned = this.blockedTokens(d);
    if (mentioned.length) {
      throw new HAError(
        `Refusing: the action data mentions blocked entities (${mentioned.slice(0, 10).join(", ")}). Blocked domains: ${blockedList}`,
      );
    }
  }

  /** Every '<blocked_domain>.<object_id>' token in a value's strings (keys and values, deep). */
  private blockedTokens(value: unknown): string[] {
    const doms = [...this.blockedDomains].map((x) => x.replace(/[^a-z0-9_]/g, "")).filter(Boolean);
    if (!doms.length) return [];
    const re = new RegExp(`(?:^|[^a-z0-9_])((?:${doms.join("|")})\\.[a-z0-9_]+)`, "gi");
    const found = new Set<string>();
    const scan = (s: string) => {
      for (const m of s.matchAll(re)) found.add(m[1].toLowerCase());
    };
    const walk = (v: unknown, depth: number) => {
      if (depth > 32 || v === null || v === undefined) return;
      if (typeof v === "string") return scan(v);
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
      if (typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          scan(k);
          walk(x, depth + 1);
        }
      }
    };
    walk(value, 0);
    return [...found];
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

  /**
   * Open a websocket, authenticate, run one command, close.
   * With `sub`, the command is a subscription: after a successful result the
   * socket stays open and each 'event' message for it goes to sub.onEvent until
   * that returns done. Closing the socket ends the subscription on HA's side.
   */
  private wsRaw<T>(
    type: string,
    payload: Record<string, unknown>,
    sub?: { onEvent: (event: unknown) => { done: boolean; value?: unknown; error?: Error }; timeoutMs?: number },
  ): Promise<T> {
    const url = this.baseUrl.replace(/^http/, "ws") + "/api/websocket";
    const started = Date.now();
    const timeoutMs = sub?.timeoutMs ?? this.timeoutMs;
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
      const timer = setTimeout(() => finish(new HAError(`Websocket timeout after ${timeoutMs}ms`)), timeoutMs);
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
          if (!msg.success) {
            const err = new HAError(`Websocket command '${type}' failed: ${msg.error?.message ?? "unknown error"}`);
            err.code = msg.error?.code;
            finish(err);
          } else if (!sub) {
            finish(null, msg.result as T);
          }
        } else if (sub && msg.type === "event" && msg.id === 1) {
          const r = sub.onEvent(msg.event);
          if (r.done) finish(r.error ?? null, r.value as T);
        }
      };
    });
  }
}
