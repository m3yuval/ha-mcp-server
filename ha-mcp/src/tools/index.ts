import type { ToolContext } from "./common.js";
import { registerReadTools } from "./read.js";
import { registerActionTools } from "./actions.js";
import { registerConfigFileTools } from "./config-files.js";
import { registerManagementTools } from "./management.js";
import { registerSupervisorTools } from "./supervisor.js";

/**
 * Register tools for the enabled capabilities only, so Claude never even sees
 * tools it is not allowed to use. The HA client enforces the same gates again.
 */
export function registerAllTools(ctx: ToolContext) {
  registerReadTools(ctx);
  if (ctx.ha.has("actions")) registerActionTools(ctx);
  if (ctx.ha.has("config") && ctx.config.configDir) registerConfigFileTools(ctx);
  if (ctx.ha.has("management")) {
    registerManagementTools(ctx);
    if (ctx.ha.hasSupervisor) registerSupervisorTools(ctx);
  }
}
