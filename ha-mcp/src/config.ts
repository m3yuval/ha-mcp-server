/**
 * All runtime configuration comes from environment variables.
 * Inside Home Assistant, the add-on entrypoint maps the add-on options
 * (/data/options.json) to these variables. See ENV CONTRACT below.
 *
 * ENV CONTRACT (the add-on entrypoint must set these):
 *   HA_URL                 Home Assistant base URL (add-on: http://supervisor/core)
 *   HA_TOKEN               Token for HA (add-on: $SUPERVISOR_TOKEN)
 *   SUPERVISOR_URL         Supervisor API base (add-on: http://supervisor). Empty = no Supervisor tools
 *   SUPERVISOR_TOKEN       Token for the Supervisor API (add-on: $SUPERVISOR_TOKEN)
 *   CONFIG_DIR             HA config directory on disk (add-on: /homeassistant). Empty = no file tools
 *   MCP_AUTH_TOKEN         Secret clients must present
 *   ENABLE_TEMPLATE_TOOL   true|false (default true)
 *   ENABLE_ACTIONS         true|false (default false)  control devices / call services
 *   ENABLE_CONFIG_FILES    true|false (default false)  create/edit YAML files in CONFIG_DIR
 *   ENABLE_MANAGEMENT      true|false (default false)  integrations, registries, add-ons, backups, system
 *   BLOCKED_DOMAINS        comma-separated domains that can never be controlled (e.g. "lock,alarm_control_panel")
 *   LOG_LEVEL              trace|debug|info|notice|warning|error|fatal (default info)
 *   MCP_TRANSPORT          http|stdio (default http)
 *   PORT / HOST            default 3000 / 0.0.0.0
 */

export type Capability = "read" | "actions" | "config" | "management";

export interface Config {
  haUrl: string;
  haToken: string;
  supervisorUrl?: string;
  supervisorToken?: string;
  configDir?: string;
  transport: "http" | "stdio";
  port: number;
  host: string;
  authToken?: string;
  allowNoAuth: boolean;
  enableTemplateTool: boolean;
  capabilities: Set<Capability>;
  blockedDomains: Set<string>;
  logLevel: string;
}

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function loadConfig(): Config {
  const haUrl = env("HA_URL");
  const haToken = env("HA_TOKEN");
  if (!haUrl || !haToken) {
    console.error("Missing required environment variable HA_URL and/or HA_TOKEN. See .env.example.");
    process.exit(1);
  }

  const capabilities = new Set<Capability>(["read"]);
  if (bool("ENABLE_ACTIONS", false)) capabilities.add("actions");
  if (bool("ENABLE_CONFIG_FILES", false)) capabilities.add("config");
  if (bool("ENABLE_MANAGEMENT", false)) capabilities.add("management");

  const authToken = env("MCP_AUTH_TOKEN");
  if (authToken && authToken.length < 32) {
    console.error(
      "MCP_AUTH_TOKEN is too short (minimum 32 characters). It is the main protection for this server. " +
        "Generate one with: openssl rand -hex 32",
    );
    process.exit(1);
  }

  return {
    haUrl,
    haToken,
    supervisorUrl: env("SUPERVISOR_URL"),
    supervisorToken: env("SUPERVISOR_TOKEN"),
    configDir: env("CONFIG_DIR"),
    transport: env("MCP_TRANSPORT", "http") as "http" | "stdio",
    port: Number(env("PORT", "3000")),
    host: env("HOST", "0.0.0.0")!,
    authToken,
    allowNoAuth: bool("ALLOW_NO_AUTH", false),
    enableTemplateTool: bool("ENABLE_TEMPLATE_TOOL", true),
    capabilities,
    blockedDomains: new Set(
      (env("BLOCKED_DOMAINS", "") ?? "")
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
    logLevel: env("LOG_LEVEL", "info")!,
  };
}
