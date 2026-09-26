#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { HAClient } from "./ha-client.js";
import { log, setLogLevel } from "./logger.js";
import { registerAllTools } from "./tools/index.js";

export const VERSION = "0.2.0";

const config = loadConfig();
setLogLevel(config.logLevel);

const ha = new HAClient({
  baseUrl: config.haUrl,
  token: config.haToken,
  capabilities: config.capabilities,
  blockedDomains: config.blockedDomains,
  supervisorUrl: config.supervisorUrl,
  supervisorToken: config.supervisorToken,
});

function instructions() {
  const parts = [
    "Access to a Home Assistant instance. Start with ha_list_domains or ha_list_areas for an overview.",
  ];
  const caps = [...config.capabilities].filter((c) => c !== "read");
  if (caps.length === 0) {
    parts.push("This server is read-only: you can inspect everything but cannot change anything.");
  } else {
    parts.push(`Enabled write capabilities: ${caps.join(", ")}.`);
    parts.push(
      "Before any tool that changes something, tell the user exactly what will change and get confirmation, especially for destructive tools (delete, overwrite, restart, uninstall).",
    );
  }
  if (config.blockedDomains.size) {
    parts.push(`These domains are blocked and cannot be controlled: ${[...config.blockedDomains].join(", ")}.`);
  }
  return parts.join(" ");
}

function buildServer() {
  const server = new McpServer({ name: "home-assistant", version: VERSION }, { instructions: instructions() });
  registerAllTools({ server, ha, config });
  return server;
}

async function runStdio() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  log.info(`home-assistant MCP ${VERSION} running on stdio`);
}

function tokensEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function clientIp(req: Request) {
  const cf = req.headers["cf-connecting-ip"];
  const xff = req.headers["x-forwarded-for"];
  return String(cf ?? (typeof xff === "string" ? xff.split(",")[0].trim() : undefined) ?? req.socket.remoteAddress ?? "?");
}

/** Describe a JSON-RPC body for the log: "tools/call ha_get_state", "initialize", ... */
function describeRpc(body: unknown): string {
  const one = (m: any) => {
    if (!m || typeof m !== "object") return "?";
    if (m.method === "tools/call") return `tools/call ${m.params?.name ?? "?"}`;
    return m.method ?? (m.result !== undefined || m.error !== undefined ? "response" : "?");
  };
  return Array.isArray(body) ? `batch[${body.map(one).join(", ")}]` : one(body);
}

async function runHttp() {
  if (!config.authToken && !config.allowNoAuth) {
    log.error(
      "MCP_AUTH_TOKEN is not set. Refusing to start an unauthenticated HTTP server. " +
        "Generate one with: openssl rand -hex 32 " +
        "(Set ALLOW_NO_AUTH=true only if something in front of this server already handles auth.)",
    );
    process.exit(1);
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "5mb" }));

  // One INFO line per request: method, redacted path, JSON-RPC method/tool,
  // client IP, status and duration. The auth token in the path is never logged.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      const path = req.path.replace(/^\/mcp\/[^/]+/, "/mcp/***");
      const rpc = req.method === "POST" && req.body ? ` ${describeRpc(req.body)}` : "";
      const line = `${req.method} ${path}${rpc} from ${clientIp(req)} -> ${res.statusCode} (${Date.now() - started}ms)`;
      if (path === "/health") log.debug(line);
      else if (res.statusCode === 401) log.warning(line);
      else log.info(line);
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  // Auth: "Authorization: Bearer <token>" header, or the token as the last path
  // segment (/mcp/<token>).
  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!config.authToken) return next();
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const pathToken = typeof req.params.token === "string" ? req.params.token : "";
    if ((bearer && tokensEqual(bearer, config.authToken)) || (pathToken && tokensEqual(pathToken, config.authToken))) {
      return next();
    }
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  };

  // Stateless Streamable HTTP: a fresh server + transport per request.
  const handle = async (req: Request, res: Response) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error(`Error handling MCP request: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  };

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server: use POST)" },
      id: null,
    });
  };

  for (const path of ["/mcp", "/mcp/:token"]) {
    app.post(path, auth, handle);
    app.get(path, auth, methodNotAllowed);
    app.delete(path, auth, methodNotAllowed);
  }

  app.listen(config.port, config.host, () => {
    const caps = [...config.capabilities].join(", ");
    log.info(`home-assistant MCP ${VERSION} listening on http://${config.host}:${config.port}/mcp`);
    log.info(`Home Assistant: ${config.haUrl}`);
    log.info(`Capabilities: ${caps}${config.blockedDomains.size ? ` | blocked domains: ${[...config.blockedDomains].join(", ")}` : ""}`);
    if (config.capabilities.has("config")) {
      log.info(config.configDir ? `Config files: ${config.configDir}` : "Config files: CONFIG_DIR not set, file tools disabled");
    }
    if (config.capabilities.has("management") && !(config.supervisorUrl && config.supervisorToken)) {
      log.info("Supervisor API not configured: add-on/backup/host tools unavailable");
    }
    if (!config.authToken) log.warning("Running without MCP_AUTH_TOKEN");
  });
}

// Exit cleanly on stop (Docker / HA Supervisor send SIGTERM).
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log.info(`Received ${sig}, shutting down`);
    process.exit(0);
  });
}

if (config.transport === "stdio") {
  runStdio().catch((err) => {
    log.error(String(err));
    process.exit(1);
  });
} else {
  runHttp().catch((err) => {
    log.error(String(err));
    process.exit(1);
  });
}
