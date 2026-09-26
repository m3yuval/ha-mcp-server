import type { ToolContext } from "./common.js";
import { registerIntegrationTools } from "./management/integrations.js";
import { registerRegistryTools } from "./management/registries.js";
import { registerAutomationTools } from "./management/automations.js";
import { registerHelperTools } from "./management/helpers.js";
import { registerSystemTools } from "./management/system.js";

/**
 * Management of Home Assistant Core (capability: management): integrations and
 * setup flows, registries, automations/scripts/scenes, blueprints, helpers,
 * people/zones/tags, users, repairs, updates, logging, recorder and restart.
 * Supervisor (add-ons, backups, host, OS) lives in supervisor.ts.
 */
export function registerManagementTools(ctx: ToolContext) {
  registerIntegrationTools(ctx);
  registerRegistryTools(ctx);
  registerAutomationTools(ctx);
  registerHelperTools(ctx);
  registerSystemTools(ctx);
}
