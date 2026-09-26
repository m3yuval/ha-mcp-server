#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HAClient } from "./ha-client.js";
import { registerTools } from "./tools.js";

const VERSION = "0.1.0";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function required(name: string): string {
  const v = env(name);
  if (!v) {
    console.error(`Missing required environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return v;
}

const config = {
  haUrl: required("HA_URL"),
  haToken: required("HA_TOKEN"),
  transport: env("MCP_TRANSPORT", "http") as "http" | "stdio",
  port: Number(env("PORT", "3000")),
  host: env("HOST", "0.0.0.0")!,
  authToken: env("MCP_AUTH_TOKEN"),
  allowNoAuth: env("ALLOW_NO_AUTH") === "true",
  enableTemplateTool: env("ENABLE_TEMPLATE_TOOL", "true") === "true",
};

const ha = new HAClient({ baseUrl: config.haUrl, token: config.haToken });

function buildServer() {
  const server = new McpServer(
    { name: "home-assistant-readonly", version: VERSION },
    {
      instructions:
        "Read-only access to a Home Assistant instance. You can list and inspect entities, areas, history, logbook, calendars and available actions, but you cannot change anything. Start with ha_list_domains or ha_list_areas for an overview.",
    },
  );
  registerTools(server, ha, { enableTemplateTool: config.enableTemplateTool });
  return server;
}

async function runStdio() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error(`home-assistant-readonly MCP ${VERSION} running on stdio`);
}

function tokensEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function runHttp() {
  if (!config.authToken && !config.allowNoAuth) {
    console.error(
      "MCP_AUTH_TOKEN is not set. Refusing to start an unauthenticated HTTP server.\n" +
        "Generate one with: openssl rand -hex 32\n" +
        "(Set ALLOW_NO_AUTH=true only if something in front of this server already handles auth.)",
    );
    process.exit(1);
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  // Auth: either "Authorization: Bearer <token>" or the token as the last path
  // segment (/mcp/<token>). The path form exists because claude.ai custom
  // connectors can't send custom headers.
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
      console.error("Error handling MCP request:", err);
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
    console.error(`home-assistant-readonly MCP ${VERSION} listening on http://${config.host}:${config.port}/mcp`);
    console.error(`Home Assistant: ${config.haUrl}`);
    if (!config.authToken) console.error("WARNING: running without MCP_AUTH_TOKEN");
  });
}

// Exit cleanly on stop (Docker / HA Supervisor send SIGTERM).
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.error(`Received ${sig}, shutting down`);
    process.exit(0);
  });
}

if (config.transport === "stdio") {
  runStdio().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runHttp().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
