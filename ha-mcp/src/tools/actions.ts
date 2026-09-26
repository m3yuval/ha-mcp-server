import { z } from "zod";
import { HAError, type ServiceCallOptions } from "../ha-client.js";
import { DESTRUCTIVE, WRITE, defineTool, type HAState, type ToolContext } from "./common.js";
import {
  ENTITY_RE,
  asArray,
  assertServiceExists,
  domainOf,
  entityId,
  entityIds,
  getCatalog,
  groupByDomain,
  hasIndirect,
  hasService,
  indirectTargetShape,
  report,
  requireEntities,
  runService,
  targetSchema,
  type CallResult,
} from "./actions/shared.js";

/** One planned service call. */
interface Planned {
  domain: string;
  service: string;
  opts: ServiceCallOptions;
}

/**
 * Device control (capability: actions).
 *
 * Every tool goes through HAClient.callService / post, which enforce the
 * 'actions' capability and blocked domains (including area/device/floor/label
 * targets). Multi-call tools check every planned call against the blocked
 * domains BEFORE sending the first one, so a refusal never leaves a partial
 * change behind.
 */
export function registerActionTools(ctx: ToolContext) {
  const { ha } = ctx;

  /** Check all calls first, then run them in order. */
  async function execute(plan: Planned[]): Promise<CallResult[]> {
    for (const p of plan) await ha.assertNotBlocked(p.domain, p.opts);
    const out: CallResult[] = [];
    for (const p of plan) out.push(await runService(ha, p.domain, p.service, p.opts));
    return out;
  }

  function indirect(args: { area_id?: unknown; floor_id?: unknown; device_id?: unknown; label_id?: unknown }) {
    return {
      area_id: args.area_id as string | string[] | undefined,
      floor_id: args.floor_id as string | string[] | undefined,
      device_id: args.device_id as string | string[] | undefined,
      label_id: args.label_id as string | string[] | undefined,
    };
  }

  // ------------------------------------------------------------ generic

  defineTool(
    ctx,
    "ha_call_service",
    {
      title: "Call any Home Assistant action (service)",
      description:
        "Call any Home Assistant action (a.k.a. service) with a target and data. Use this when no specific ha_* control tool fits " +
        "(e.g. lock.unlock, alarm_control_panel.alarm_arm_away, input_select.select_next, homeassistant.reload_all, weather.get_forecasts). " +
        "Use ha_list_services with a domain to see an action's fields first. The action is checked to exist before anything is sent.\n" +
        "Examples:\n" +
        "- {domain:'light', service:'turn_on', target:{area_id:'kitchen'}, data:{brightness_pct:40}}\n" +
        "- {domain:'weather', service:'get_forecasts', target:{entity_id:'weather.home'}, data:{type:'daily'}, return_response:true}\n" +
        "- {domain:'homeassistant', service:'update_entity', target:{entity_id:['sensor.a','sensor.b']}}\n" +
        "Returns the new state of targeted entities (or the states the call changed) and, with return_response, the action's response data.",
      inputSchema: {
        domain: z.string().regex(/^[a-z0-9_]+$/, "lowercase domain, e.g. 'light'").describe("Action domain, e.g. 'light', 'script', 'notify'"),
        service: z.string().regex(/^[a-z0-9_]+$/, "lowercase action name, e.g. 'turn_on'").describe("Action name, e.g. 'turn_on', 'reload'"),
        target: targetSchema.optional().describe("What to act on: entity_id, device_id, area_id, floor_id and/or label_id (string or list)"),
        data: z.record(z.unknown()).optional().describe("Action data (fields), e.g. {brightness_pct: 50} or {message: 'hi'}"),
        return_response: z
          .boolean()
          .optional()
          .describe("Ask for the action's response data (for actions that return data, e.g. weather.get_forecasts, todo.get_items, calendar.get_events). Set automatically when the action requires it."),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ domain, service, target, data, return_response }) => {
      const meta = await assertServiceExists(ha, domain, service);
      const ids = asArray<string>(target?.entity_id).filter((e) => e.toLowerCase() !== "all");
      const bad = ids.filter((e) => !ENTITY_RE.test(e));
      if (bad.length) throw new HAError(`Invalid entity id(s): ${bad.join(", ")}. Expected 'domain.object_id', e.g. 'light.kitchen'.`);
      if (ids.length) await requireEntities(ha, ids);
      let returnResponse = return_response;
      let note: string | undefined;
      if (returnResponse === undefined && meta.response && meta.response.optional === false) {
        returnResponse = true;
        note = "return_response was enabled automatically because this action always returns data";
      }
      const [res] = await execute([{ domain, service, opts: { target, data, returnResponse } }]);
      const extra: Record<string, unknown> = {};
      if (returnResponse) extra.service_response = res.service_response ?? null;
      if (note) extra.note = note;
      return report(ha, [res], ids, extra);
    },
  );

  // ------------------------------------------------------- on / off / toggle

  /** Domains without turn_on/turn_off that map to other native actions. */
  const SWITCH_ALIASES: Record<string, Record<string, string>> = {
    cover: { turn_on: "open_cover", turn_off: "close_cover", toggle: "toggle" },
    valve: { turn_on: "open_valve", turn_off: "close_valve", toggle: "toggle" },
    lock: {}, // never mapped: locking/unlocking is not "on/off"; use ha_call_service
  };
  /** Domains that only work through homeassistant.turn_on/off/toggle. */
  const VIA_HOMEASSISTANT = new Set(["group"]);

  async function resolveSwitch(domain: string, service: string): Promise<{ domain: string; service: string }> {
    const alias = SWITCH_ALIASES[domain];
    if (alias) {
      if (alias[service]) return { domain, service: alias[service] };
    } else if (await hasService(ha, domain, service)) {
      return { domain, service };
    } else if (VIA_HOMEASSISTANT.has(domain)) {
      return { domain: "homeassistant", service };
    }
    throw new HAError(
      `'${domain}' entities can't be switched with ${service}. Use ha_call_service with a ${domain} action instead (see ha_list_services domain='${domain}').`,
    );
  }

  const switchTool = (service: "turn_on" | "turn_off" | "toggle") => {
    const verb = { turn_on: "Turn on", turn_off: "Turn off", toggle: "Toggle" }[service];
    const lightFields: z.ZodRawShape =
      service === "turn_on"
        ? {
            brightness_pct: z.number().min(0).max(100).optional().describe("Lights: brightness 0-100%"),
            color_name: z.string().optional().describe("Lights: CSS color name, e.g. 'red', 'warmwhite'"),
            rgb_color: z.array(z.number().int().min(0).max(255)).length(3).optional().describe("Lights: [r,g,b]"),
            color_temp_kelvin: z.number().int().min(1000).max(12000).optional().describe("Lights: color temperature in Kelvin, e.g. 2700"),
            percentage: z.number().min(0).max(100).optional().describe("Fans: speed 0-100%"),
          }
        : {};
    defineTool(
      ctx,
      `ha_${service}`,
      {
        title: `${verb} entities`,
        description:
          `${verb} one or more entities of any switchable type: light, switch, fan, input_boolean, media_player, climate, humidifier, ` +
          `water_heater, siren, remote, automation, script, group, cover (${service === "turn_on" ? "opens" : service === "turn_off" ? "closes" : "toggles"}), valve. ` +
          `Each entity's own domain action is used (e.g. light.${service}). You can also target whole areas/floors/devices/labels; ` +
          `add 'domain' to limit that to one kind, e.g. {area_id:'kitchen', domain:'light'} → only the kitchen lights. ` +
          (service === "turn_on"
            ? "Light/fan options: brightness_pct, color_name, rgb_color, color_temp_kelvin, percentage, transition; anything else goes in 'data'. "
            : "") +
          `Examples: {entity_ids:['light.kitchen','switch.fan']}` +
          (service === "turn_on" ? `, {entity_ids:'light.desk', brightness_pct:30, color_temp_kelvin:2700}` : "") +
          `, {floor_id:'upstairs', domain:'light'}. Returns the new states. For locks, alarms and other non-switch actions use ha_call_service.`,
        inputSchema: {
          entity_ids: entityIds().optional().describe("Entity id or list, e.g. 'light.kitchen' or ['light.a','fan.b']"),
          ...indirectTargetShape,
          domain: z
            .string()
            .regex(/^[a-z0-9_]+$/)
            .optional()
            .describe("With area/floor/device/label targets: only act on this kind of entity, e.g. 'light'. Without it, everything switchable there is affected."),
          ...lightFields,
          transition: z.number().min(0).max(3600).optional().describe("Lights: fade time in seconds"),
          data: z.record(z.unknown()).optional().describe("Extra action data, e.g. {effect:'colorloop'} or {hvac_mode:'heat'}"),
        },
        annotations: WRITE,
      },
      async (args) => {
        const ids: string[] = asArray(args.entity_ids);
        const ind = indirect(args);
        if (!ids.length && !hasIndirect(ind)) {
          throw new HAError("Give entity_ids and/or area_id / floor_id / device_id / label_id.");
        }
        const data: Record<string, unknown> = { ...(args.data ?? {}) };
        for (const k of ["brightness_pct", "color_name", "rgb_color", "color_temp_kelvin", "percentage", "transition"]) {
          if (args[k] !== undefined) data[k] = args[k];
        }
        const hasData = Object.keys(data).length > 0;

        const plan: Planned[] = [];
        if (ids.length) {
          await requireEntities(ha, ids);
          for (const [d, group] of groupByDomain(ids)) {
            const r = await resolveSwitch(d, service);
            plan.push({ domain: r.domain, service: r.service, opts: { target: { entity_id: group }, data: hasData ? data : undefined } });
          }
        }
        if (hasIndirect(ind)) {
          if (args.domain) {
            const r = await resolveSwitch(args.domain, service);
            plan.push({ domain: r.domain, service: r.service, opts: { target: ind, data: hasData ? data : undefined } });
          } else {
            if (hasData) {
              throw new HAError("When passing brightness/color/data to an area, floor, device or label, also set 'domain' (e.g. 'light').");
            }
            plan.push({ domain: "homeassistant", service, opts: { target: ind } });
          }
        }
        const calls = await execute(plan);
        return report(ha, calls, ids);
      },
    );
  };
  switchTool("turn_on");
  switchTool("turn_off");
  switchTool("toggle");

  // ------------------------------------------------------------- climate

  defineTool(
    ctx,
    "ha_set_climate",
    {
      title: "Set thermostat / AC",
      description:
        "Control climate entities (thermostats, AC, heat pumps): HVAC mode, target temperature or range, fan mode, preset, swing, humidity. " +
        "Values are checked against what the device supports (its hvac_modes, fan_modes, preset_modes, swing_modes attributes). " +
        "Examples: {entity_ids:'climate.living_room', hvac_mode:'cool', temperature:23}; " +
        "{entity_ids:['climate.a','climate.b'], preset_mode:'eco'}; {entity_ids:'climate.hall', target_temp_low:19, target_temp_high:24}. " +
        "To just switch it off use hvac_mode:'off'. Returns the new states.",
      inputSchema: {
        entity_ids: entityIds(["climate"]).describe("climate.* entity id or list"),
        hvac_mode: z.enum(["off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only"]).optional(),
        temperature: z.number().optional().describe("Target temperature (in HA's unit system)"),
        target_temp_low: z.number().optional().describe("Lower bound of a target range (heat_cool mode)"),
        target_temp_high: z.number().optional().describe("Upper bound of a target range (heat_cool mode)"),
        fan_mode: z.string().optional().describe("e.g. 'auto', 'low', 'high'"),
        preset_mode: z.string().optional().describe("e.g. 'eco', 'away', 'comfort'"),
        swing_mode: z.string().optional().describe("e.g. 'on', 'off', 'vertical'"),
        humidity: z.number().min(0).max(100).optional().describe("Target humidity %"),
      },
      annotations: WRITE,
    },
    async (a) => {
      const ids: string[] = asArray(a.entity_ids);
      const hasRange = a.target_temp_low !== undefined || a.target_temp_high !== undefined;
      if (a.temperature !== undefined && hasRange) throw new HAError("Use either temperature or target_temp_low/high, not both.");
      if (hasRange && (a.target_temp_low === undefined || a.target_temp_high === undefined)) {
        throw new HAError("A temperature range needs both target_temp_low and target_temp_high.");
      }
      if ([a.hvac_mode, a.temperature, a.target_temp_low, a.fan_mode, a.preset_mode, a.swing_mode, a.humidity].every((v) => v === undefined)) {
        throw new HAError("Nothing to set: give hvac_mode, temperature, a target range, fan_mode, preset_mode, swing_mode or humidity.");
      }
      const states = await requireEntities(ha, ids);
      const checks: [string, string | undefined, string][] = [
        ["hvac_mode", a.hvac_mode, "hvac_modes"],
        ["fan_mode", a.fan_mode, "fan_modes"],
        ["preset_mode", a.preset_mode, "preset_modes"],
        ["swing_mode", a.swing_mode, "swing_modes"],
      ];
      for (const [field, value, attr] of checks) {
        if (value === undefined) continue;
        for (const id of ids) {
          const allowed = states.get(id)!.attributes?.[attr];
          if (Array.isArray(allowed) && !allowed.includes(value)) {
            throw new HAError(`${id} does not support ${field} '${value}'. Supported: ${allowed.join(", ")}.`);
          }
        }
      }
      const target = { entity_id: ids };
      const plan: Planned[] = [];
      const setsTemp = a.temperature !== undefined || hasRange;
      if (a.hvac_mode && !setsTemp) plan.push({ domain: "climate", service: "set_hvac_mode", opts: { target, data: { hvac_mode: a.hvac_mode } } });
      if (a.preset_mode) plan.push({ domain: "climate", service: "set_preset_mode", opts: { target, data: { preset_mode: a.preset_mode } } });
      if (a.fan_mode) plan.push({ domain: "climate", service: "set_fan_mode", opts: { target, data: { fan_mode: a.fan_mode } } });
      if (a.swing_mode) plan.push({ domain: "climate", service: "set_swing_mode", opts: { target, data: { swing_mode: a.swing_mode } } });
      if (a.humidity !== undefined) plan.push({ domain: "climate", service: "set_humidity", opts: { target, data: { humidity: a.humidity } } });
      if (setsTemp) {
        plan.push({
          domain: "climate",
          service: "set_temperature",
          opts: {
            target,
            data: {
              temperature: a.temperature,
              target_temp_low: a.target_temp_low,
              target_temp_high: a.target_temp_high,
              hvac_mode: a.hvac_mode,
            },
          },
        });
      }
      return report(ha, await execute(plan), ids);
    },
  );

  // --------------------------------------------------------------- covers

  const COVER_ACTIONS = ["open", "close", "stop", "toggle", "set_position", "open_tilt", "close_tilt", "stop_tilt", "set_tilt_position"] as const;
  const COVER_MAP: Record<string, Record<string, string>> = {
    cover: {
      open: "open_cover",
      close: "close_cover",
      stop: "stop_cover",
      toggle: "toggle",
      set_position: "set_cover_position",
      open_tilt: "open_cover_tilt",
      close_tilt: "close_cover_tilt",
      stop_tilt: "stop_cover_tilt",
      set_tilt_position: "set_cover_tilt_position",
    },
    valve: { open: "open_valve", close: "close_valve", stop: "stop_valve", toggle: "toggle", set_position: "set_valve_position" },
  };

  defineTool(
    ctx,
    "ha_control_cover",
    {
      title: "Control covers and valves",
      description:
        "Open, close, stop or position covers (blinds, shades, curtains, shutters, awnings, garage doors, gates) and valves. " +
        "Actions: open, close, stop, toggle, set_position (position 0=closed..100=open), and for tilting blinds open_tilt, close_tilt, stop_tilt, set_tilt_position (tilt_position 0-100). " +
        "Target entity ids and/or whole areas/floors (area targets act on covers there). " +
        "Examples: {entity_ids:'cover.living_room_blinds', action:'set_position', position:30}; {area_id:'bedroom', action:'close'}. Returns the new states.",
      inputSchema: {
        entity_ids: entityIds(["cover", "valve"]).optional().describe("cover.* or valve.* entity id or list"),
        ...indirectTargetShape,
        action: z.enum(COVER_ACTIONS),
        position: z.number().int().min(0).max(100).optional().describe("For set_position: 0 = closed, 100 = fully open"),
        tilt_position: z.number().int().min(0).max(100).optional().describe("For set_tilt_position: 0-100"),
      },
      annotations: WRITE,
    },
    async (a) => {
      const ids: string[] = asArray(a.entity_ids);
      const ind = indirect(a);
      if (!ids.length && !hasIndirect(ind)) throw new HAError("Give entity_ids and/or area_id / floor_id / device_id / label_id.");
      if (a.action === "set_position" && a.position === undefined) throw new HAError("set_position needs 'position' (0-100).");
      if (a.action === "set_tilt_position" && a.tilt_position === undefined) throw new HAError("set_tilt_position needs 'tilt_position' (0-100).");
      const data =
        a.action === "set_position" ? { position: a.position } : a.action === "set_tilt_position" ? { tilt_position: a.tilt_position } : undefined;
      const plan: Planned[] = [];
      if (ids.length) {
        await requireEntities(ha, ids);
        for (const [d, group] of groupByDomain(ids)) {
          const svc = COVER_MAP[d][a.action];
          if (!svc) throw new HAError(`${d} entities don't support '${a.action}'.`);
          plan.push({ domain: d, service: svc, opts: { target: { entity_id: group }, data } });
        }
      }
      if (hasIndirect(ind)) plan.push({ domain: "cover", service: COVER_MAP.cover[a.action], opts: { target: ind, data } });
      return report(ha, await execute(plan), ids);
    },
  );

  // --------------------------------------------------------- media players

  const MEDIA: Record<string, { service: string; needs?: string }> = {
    play: { service: "media_play" },
    pause: { service: "media_pause" },
    play_pause: { service: "media_play_pause" },
    stop: { service: "media_stop" },
    next: { service: "media_next_track" },
    previous: { service: "media_previous_track" },
    volume_set: { service: "volume_set", needs: "volume_level" },
    volume_up: { service: "volume_up" },
    volume_down: { service: "volume_down" },
    mute: { service: "volume_mute" },
    unmute: { service: "volume_mute" },
    select_source: { service: "select_source", needs: "source" },
    select_sound_mode: { service: "select_sound_mode", needs: "sound_mode" },
    play_media: { service: "play_media", needs: "media_content_id" },
    shuffle: { service: "shuffle_set", needs: "shuffle" },
    repeat: { service: "repeat_set", needs: "repeat" },
    seek: { service: "media_seek", needs: "seek_position" },
  };

  defineTool(
    ctx,
    "ha_control_media_player",
    {
      title: "Control media players",
      description:
        "Control media players (speakers, TVs, receivers, Chromecast, Sonos, etc.). Actions: play, pause, play_pause, stop, next, previous, " +
        "volume_set (volume_level 0.0-1.0), volume_up, volume_down, mute, unmute, select_source (source, from the player's source_list), " +
        "select_sound_mode (sound_mode), play_media (media_content_id + media_content_type, e.g. 'music', 'playlist', 'url', 'channel'), " +
        "shuffle (shuffle true/false), repeat (repeat off|one|all), seek (seek_position seconds). Use ha_turn_on / ha_turn_off to power on/off. " +
        "Examples: {entity_ids:'media_player.living_room', action:'volume_set', volume_level:0.3}; " +
        "{entity_ids:'media_player.kitchen', action:'play_media', media_content_id:'https://example.com/stream.mp3', media_content_type:'music'}. Returns the new states.",
      inputSchema: {
        entity_ids: entityIds(["media_player"]).describe("media_player.* entity id or list"),
        action: z.enum(Object.keys(MEDIA) as [string, ...string[]]),
        volume_level: z.number().min(0).max(1).optional().describe("volume_set: 0.0-1.0"),
        source: z.string().optional().describe("select_source: input/source name"),
        sound_mode: z.string().optional().describe("select_sound_mode: sound mode name"),
        media_content_id: z.string().optional().describe("play_media: URL, media id, playlist id, channel, …"),
        media_content_type: z.string().optional().describe("play_media: e.g. 'music', 'video', 'playlist', 'url', 'channel' (default 'music')"),
        enqueue: z.enum(["play", "next", "add", "replace"]).optional().describe("play_media: queue behavior"),
        announce: z.boolean().optional().describe("play_media: play as an announcement (pauses and resumes current media)"),
        shuffle: z.boolean().optional(),
        repeat: z.enum(["off", "one", "all"]).optional(),
        seek_position: z.number().min(0).optional().describe("seek: position in seconds"),
      },
      annotations: WRITE,
    },
    async (a) => {
      const ids: string[] = asArray(a.entity_ids);
      const spec = MEDIA[a.action];
      if (spec.needs && a[spec.needs] === undefined) throw new HAError(`Action '${a.action}' needs '${spec.needs}'.`);
      const states = await requireEntities(ha, ids);
      let data: Record<string, unknown> | undefined;
      switch (a.action) {
        case "volume_set":
          data = { volume_level: a.volume_level };
          break;
        case "mute":
        case "unmute":
          data = { is_volume_muted: a.action === "mute" };
          break;
        case "select_source":
          for (const id of ids) {
            const list = states.get(id)!.attributes?.source_list;
            if (Array.isArray(list) && !list.includes(a.source)) {
              throw new HAError(`${id} has no source '${a.source}'. Available: ${list.join(", ")}.`);
            }
          }
          data = { source: a.source };
          break;
        case "select_sound_mode":
          data = { sound_mode: a.sound_mode };
          break;
        case "play_media":
          data = {
            media_content_id: a.media_content_id,
            media_content_type: a.media_content_type ?? "music",
            enqueue: a.enqueue,
            announce: a.announce,
          };
          break;
        case "shuffle":
          data = { shuffle: a.shuffle };
          break;
        case "repeat":
          data = { repeat: a.repeat };
          break;
        case "seek":
          data = { seek_position: a.seek_position };
          break;
      }
      return report(ha, await execute([{ domain: "media_player", service: spec.service, opts: { target: { entity_id: ids }, data } }]), ids);
    },
  );

  // ------------------------------------------------------------ set value

  const VALUE_DOMAINS = [
    "input_number",
    "number",
    "input_text",
    "text",
    "input_select",
    "select",
    "input_datetime",
    "datetime",
    "date",
    "time",
    "input_boolean",
    "counter",
  ] as const;

  function planSetValue(id: string, st: HAState, value: string | number | boolean): Planned {
    const d = domainOf(id);
    const target = { entity_id: id };
    const attrs = st.attributes ?? {};
    const str = String(value);
    switch (d) {
      case "input_number":
      case "number":
      case "counter": {
        const n = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(n)) throw new HAError(`${id} needs a number, got '${str}'.`);
        const min = attrs.min as number | undefined;
        const max = attrs.max as number | undefined;
        if (d !== "counter" && ((min !== undefined && n < min) || (max !== undefined && n > max))) {
          throw new HAError(`${n} is out of range for ${id} (min ${min}, max ${max}).`);
        }
        if (d === "counter" && !Number.isInteger(n)) throw new HAError(`${id} needs a whole number.`);
        return { domain: d, service: "set_value", opts: { target, data: { value: n } } };
      }
      case "input_text":
      case "text":
        return { domain: d, service: "set_value", opts: { target, data: { value: str } } };
      case "input_select":
      case "select": {
        const options = attrs.options;
        if (Array.isArray(options) && !options.includes(str)) {
          throw new HAError(`'${str}' is not an option of ${id}. Options: ${options.join(", ")}.`);
        }
        return { domain: d, service: "select_option", opts: { target, data: { option: str } } };
      }
      case "input_boolean": {
        const on = typeof value === "boolean" ? value : ["on", "true", "1", "yes"].includes(str.toLowerCase());
        if (typeof value !== "boolean" && !["on", "off", "true", "false", "1", "0", "yes", "no"].includes(str.toLowerCase())) {
          throw new HAError(`${id} needs true/false or 'on'/'off', got '${str}'.`);
        }
        return { domain: d, service: on ? "turn_on" : "turn_off", opts: { target } };
      }
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) throw new HAError(`${id} needs a date like '2026-05-01'.`);
        return { domain: d, service: "set_value", opts: { target, data: { date: str } } };
      case "time":
        if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(str)) throw new HAError(`${id} needs a time like '07:30' or '07:30:00'.`);
        return { domain: d, service: "set_value", opts: { target, data: { time: str } } };
      case "datetime":
        if (Number.isNaN(Date.parse(str))) throw new HAError(`${id} needs a date-time like '2026-05-01T07:30:00+00:00'.`);
        return { domain: d, service: "set_value", opts: { target, data: { datetime: str } } };
      case "input_datetime": {
        let data: Record<string, unknown>;
        if (typeof value === "number") data = { timestamp: value };
        else if (/^\d{4}-\d{2}-\d{2}$/.test(str)) data = { date: str };
        else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(str)) data = { time: str };
        else if (!Number.isNaN(Date.parse(str))) data = { datetime: str.replace("T", " ").replace(/(Z|[+-]\d{2}:?\d{2})$/, "") };
        else throw new HAError(`${id} needs a date ('2026-05-01'), time ('07:30'), or date-time ('2026-05-01 07:30:00').`);
        return { domain: d, service: "set_datetime", opts: { target, data } };
      }
    }
    throw new HAError(`Unsupported domain '${d}'.`);
  }

  defineTool(
    ctx,
    "ha_set_value",
    {
      title: "Set a helper / number / select / text / date value",
      description:
        "Set the value of a value-holding entity; the right action is picked from its domain: " +
        "input_number / number / counter → set_value (number, range-checked); input_text / text → set_value; " +
        "input_select / select → select_option (must be one of its options); input_boolean → on/off (true/false); " +
        "date ('2026-05-01'), time ('07:30'), datetime ('2026-05-01T07:30:00+02:00'), input_datetime (date, time or 'YYYY-MM-DD HH:MM:SS'). " +
        "Examples: {entity_id:'input_number.target_temp', value:21.5}; {entity_id:'select.washer_program', value:'Eco'}; " +
        "{entity_id:'input_datetime.alarm', value:'06:45'}. Returns the new state.",
      inputSchema: {
        entity_id: entityId(VALUE_DOMAINS).describe(`Entity of one of: ${VALUE_DOMAINS.join(", ")}`),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("The new value"),
      },
      annotations: WRITE,
    },
    async ({ entity_id, value }) => {
      const states = await requireEntities(ha, [entity_id]);
      const plan = planSetValue(entity_id, states.get(entity_id)!, value);
      return report(ha, await execute([plan]), [entity_id]);
    },
  );

  // --------------------------------------------------------------- scripts

  defineTool(
    ctx,
    "ha_run_script",
    {
      title: "Run a script",
      description:
        "Run a Home Assistant script, optionally with variables (the script's fields). By default it starts the script and returns right away. " +
        "Set wait_for_response:true to wait until the script finishes and get the data it returns (its response_variable); " +
        "only do this for short scripts. Examples: {entity_id:'script.good_night'}; " +
        "{entity_id:'script.announce', variables:{message:'Dinner is ready'}, wait_for_response:true}.",
      inputSchema: {
        entity_id: entityId(["script"]).describe("script.* entity id"),
        variables: z.record(z.unknown()).optional().describe("Script fields/variables, e.g. {message:'hi', volume:0.4}"),
        wait_for_response: z.boolean().default(false).describe("Wait for the script to finish and return its response data"),
      },
      annotations: WRITE,
    },
    async ({ entity_id, variables, wait_for_response }) => {
      await requireEntities(ha, [entity_id]);
      if (wait_for_response) {
        const objectId = entity_id.split(".")[1];
        const [res] = await execute([{ domain: "script", service: objectId, opts: { data: variables, returnResponse: true } }]);
        return report(ha, [res], [entity_id], { service_response: res.service_response ?? null });
      }
      const calls = await execute([
        { domain: "script", service: "turn_on", opts: { target: { entity_id }, data: variables ? { variables } : undefined } },
      ]);
      return report(ha, calls, [entity_id], { note: "Script started; it may still be running." });
    },
  );

  // ---------------------------------------------------------------- scenes

  defineTool(
    ctx,
    "ha_activate_scene",
    {
      title: "Activate a scene",
      description:
        "Activate one or more scenes (scene.*), optionally fading lights over 'transition' seconds. Example: {entity_ids:'scene.movie_night', transition:2}.",
      inputSchema: {
        entity_ids: entityIds(["scene"]).describe("scene.* entity id or list"),
        transition: z.number().min(0).max(3600).optional().describe("Fade time in seconds for lights that support it"),
      },
      annotations: WRITE,
    },
    async ({ entity_ids, transition }) => {
      const ids: string[] = asArray(entity_ids);
      await requireEntities(ha, ids);
      const calls = await execute([{ domain: "scene", service: "turn_on", opts: { target: { entity_id: ids }, data: { transition } } }]);
      return report(ha, calls, ids);
    },
  );

  // ----------------------------------------------------------- automations

  defineTool(
    ctx,
    "ha_trigger_automation",
    {
      title: "Trigger an automation",
      description:
        "Run an automation's actions now, as if it had been triggered. By default its conditions are skipped (skip_condition:true); " +
        "set skip_condition:false to only run if its conditions currently pass. Example: {entity_ids:'automation.porch_light_at_sunset'}.",
      inputSchema: {
        entity_ids: entityIds(["automation"]).describe("automation.* entity id or list"),
        skip_condition: z.boolean().default(true).describe("Skip the automation's conditions (default true)"),
      },
      annotations: WRITE,
    },
    async ({ entity_ids, skip_condition }) => {
      const ids: string[] = asArray(entity_ids);
      await requireEntities(ha, ids);
      const calls = await execute([{ domain: "automation", service: "trigger", opts: { target: { entity_id: ids }, data: { skip_condition } } }]);
      return report(ha, calls, ids);
    },
  );

  defineTool(
    ctx,
    "ha_set_automation_enabled",
    {
      title: "Enable or disable automations",
      description:
        "Enable (enabled:true) or disable (enabled:false) automations so they do or don't react to their triggers. " +
        "When disabling, currently running actions are stopped unless stop_actions:false. Example: {entity_ids:'automation.motion_lights', enabled:false}.",
      inputSchema: {
        entity_ids: entityIds(["automation"]).describe("automation.* entity id or list"),
        enabled: z.boolean(),
        stop_actions: z.boolean().default(true).describe("When disabling: stop any running actions (default true)"),
      },
      annotations: WRITE,
    },
    async ({ entity_ids, enabled, stop_actions }) => {
      const ids: string[] = asArray(entity_ids);
      await requireEntities(ha, ids);
      const calls = await execute([
        {
          domain: "automation",
          service: enabled ? "turn_on" : "turn_off",
          opts: { target: { entity_id: ids }, data: enabled ? undefined : { stop_actions } },
        },
      ]);
      return report(ha, calls, ids);
    },
  );

  // --------------------------------------------------------------- buttons

  defineTool(
    ctx,
    "ha_press_button",
    {
      title: "Press a button",
      description:
        "Press button entities (button.* from devices, e.g. restart, identify, start-a-program) or input_button helpers. Example: {entity_ids:'button.coffee_machine_brew'}.",
      inputSchema: {
        entity_ids: entityIds(["button", "input_button"]).describe("button.* or input_button.* entity id or list"),
      },
      annotations: WRITE,
    },
    async ({ entity_ids }) => {
      const ids: string[] = asArray(entity_ids);
      await requireEntities(ha, ids);
      const plan: Planned[] = [...groupByDomain(ids)].map(([d, group]) => ({ domain: d, service: "press", opts: { target: { entity_id: group } } }));
      return report(ha, await execute(plan), ids);
    },
  );

  // --------------------------------------------------------- notifications

  defineTool(
    ctx,
    "ha_send_notification",
    {
      title: "Send a notification",
      description:
        "Send a notification. Pick exactly one destination:\n" +
        "- service: a legacy notify action, e.g. 'mobile_app_pixel_8' (or 'notify.mobile_app_pixel_8') for the companion app; supports 'data' (e.g. {actions:[…], image:'…'}) and 'target'.\n" +
        "- entity_id: a notify.* entity (new-style notifiers) → notify.send_message.\n" +
        "- persistent:true: a persistent notification in the Home Assistant UI.\n" +
        "If unsure, call without a destination to get the list of available notify actions. " +
        "Example: {service:'mobile_app_phone', title:'Door', message:'Front door opened', data:{priority:'high'}}.",
      inputSchema: {
        message: z.string().min(1).max(4000),
        title: z.string().max(200).optional(),
        service: z
          .string()
          .regex(/^(notify\.)?[a-z0-9_]+$/)
          .optional()
          .describe("notify action name, e.g. 'mobile_app_my_phone' or 'notify.mobile_app_my_phone'"),
        entity_id: entityId(["notify"]).optional().describe("notify.* entity"),
        persistent: z.boolean().optional().describe("Create a persistent notification in the HA UI"),
        target: z.union([z.string(), z.array(z.string())]).optional().describe("Legacy notify 'target' field (service mode only)"),
        data: z.record(z.unknown()).optional().describe("Extra platform-specific data (service mode only)"),
      },
      annotations: WRITE,
    },
    async (a) => {
      const modes = [a.service, a.entity_id, a.persistent ? true : undefined].filter((v) => v !== undefined);
      if (modes.length !== 1) {
        const catalog = await getCatalog(ha);
        const notify = [...(catalog.get("notify")?.keys() ?? [])].filter((s) => s !== "send_message").sort();
        throw new HAError(
          `Give exactly one of service, entity_id or persistent:true. Available notify actions: ${notify.join(", ") || "(none)"}. ` +
            "notify.* entities can be listed with ha_list_entities domain='notify'.",
        );
      }
      let plan: Planned;
      if (a.persistent) {
        plan = { domain: "persistent_notification", service: "create", opts: { data: { message: a.message, title: a.title } } };
      } else if (a.entity_id) {
        await requireEntities(ha, [a.entity_id]);
        plan = { domain: "notify", service: "send_message", opts: { target: { entity_id: a.entity_id }, data: { message: a.message, title: a.title } } };
      } else {
        const svc = String(a.service).replace(/^notify\./, "");
        await assertServiceExists(ha, "notify", svc);
        plan = { domain: "notify", service: svc, opts: { data: { message: a.message, title: a.title, target: a.target, data: a.data } } };
      }
      const [res] = await execute([plan]);
      return { ok: true, actions: [res.action] };
    },
  );

  // ------------------------------------------------------ vacuums / mowers

  const ROBOT: Record<string, Record<string, string>> = {
    vacuum: {
      start: "start",
      pause: "pause",
      stop: "stop",
      return_to_base: "return_to_base",
      locate: "locate",
      clean_spot: "clean_spot",
      set_fan_speed: "set_fan_speed",
    },
    lawn_mower: { start: "start_mowing", pause: "pause", return_to_base: "dock" },
  };

  defineTool(
    ctx,
    "ha_vacuum",
    {
      title: "Control robot vacuums and lawn mowers",
      description:
        "Control robot vacuums (vacuum.*): start, pause, stop, return_to_base, locate, clean_spot, set_fan_speed (fan_speed from its fan_speed_list). " +
        "Also robot lawn mowers (lawn_mower.*): start, pause, return_to_base (dock). Example: {entity_ids:'vacuum.roborock', action:'return_to_base'}.",
      inputSchema: {
        entity_ids: entityIds(["vacuum", "lawn_mower"]).describe("vacuum.* or lawn_mower.* entity id or list"),
        action: z.enum(["start", "pause", "stop", "return_to_base", "locate", "clean_spot", "set_fan_speed"]),
        fan_speed: z.string().optional().describe("For set_fan_speed, e.g. 'quiet', 'max'"),
      },
      annotations: WRITE,
    },
    async ({ entity_ids, action, fan_speed }) => {
      const ids: string[] = asArray(entity_ids);
      if (action === "set_fan_speed" && !fan_speed) throw new HAError("set_fan_speed needs 'fan_speed'.");
      const states = await requireEntities(ha, ids);
      const plan: Planned[] = [];
      for (const [d, group] of groupByDomain(ids)) {
        const svc = ROBOT[d][action];
        if (!svc) throw new HAError(`${d} entities don't support '${action}'. Supported: ${Object.keys(ROBOT[d]).join(", ")}.`);
        if (action === "set_fan_speed") {
          for (const id of group) {
            const list = states.get(id)!.attributes?.fan_speed_list;
            if (Array.isArray(list) && !list.includes(fan_speed)) {
              throw new HAError(`${id} has no fan speed '${fan_speed}'. Available: ${list.join(", ")}.`);
            }
          }
        }
        plan.push({ domain: d, service: svc, opts: { target: { entity_id: group }, data: action === "set_fan_speed" ? { fan_speed } : undefined } });
      }
      return report(ha, await execute(plan), ids);
    },
  );

  // ---------------------------------------------------------------- to-dos

  defineTool(
    ctx,
    "ha_manage_todo",
    {
      title: "Manage to-do / shopping lists",
      description:
        "Read and edit to-do lists (todo.*, e.g. the shopping list). Actions:\n" +
        "- get_items: list items (optionally status_filter ['needs_action'] or ['completed']).\n" +
        "- add_item: item (+ optional due_date 'YYYY-MM-DD' or due_datetime, description).\n" +
        "- update_item: item (current name or uid) + rename / status ('needs_action'|'completed') / due_date / due_datetime / description.\n" +
        "- remove_item: item (name/uid or list of them).\n" +
        "- remove_completed: remove all completed items.\n" +
        "Examples: {entity_id:'todo.shopping_list', action:'add_item', item:'Milk'}; {entity_id:'todo.shopping_list', action:'update_item', item:'Milk', status:'completed'}.",
      inputSchema: {
        entity_id: entityId(["todo"]).describe("todo.* entity id"),
        action: z.enum(["get_items", "add_item", "update_item", "remove_item", "remove_completed"]),
        item: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional().describe("Item name or uid (a list is allowed for remove_item)"),
        rename: z.string().min(1).optional().describe("update_item: new name"),
        status: z.enum(["needs_action", "completed"]).optional().describe("update_item: new status"),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
        due_datetime: z.string().optional().describe("ISO date-time, e.g. '2026-05-01T18:00:00'"),
        description: z.string().optional(),
        status_filter: z.array(z.enum(["needs_action", "completed"])).optional().describe("get_items: only these statuses"),
      },
      annotations: WRITE,
    },
    async (a) => {
      const id: string = a.entity_id;
      await requireEntities(ha, [id]);
      const target = { entity_id: id };
      const items = asArray<string>(a.item);
      const needItem = ["add_item", "update_item", "remove_item"].includes(a.action);
      if (needItem && !items.length) throw new HAError(`'${a.action}' needs 'item'.`);
      if ((a.action === "add_item" || a.action === "update_item") && items.length > 1) throw new HAError(`'${a.action}' takes a single item.`);
      if (a.due_date && a.due_datetime) throw new HAError("Use either due_date or due_datetime, not both.");
      switch (a.action) {
        case "get_items": {
          const [res] = await execute([
            { domain: "todo", service: "get_items", opts: { target, data: { status: a.status_filter }, returnResponse: true } },
          ]);
          const resp = (res.service_response ?? {}) as Record<string, { items?: unknown[] }>;
          const list = resp[id]?.items ?? [];
          return { entity_id: id, count: list.length, items: list };
        }
        case "add_item": {
          const calls = await execute([
            {
              domain: "todo",
              service: "add_item",
              opts: { target, data: { item: items[0], due_date: a.due_date, due_datetime: a.due_datetime, description: a.description } },
            },
          ]);
          return report(ha, calls, [id]);
        }
        case "update_item": {
          if ([a.rename, a.status, a.due_date, a.due_datetime, a.description].every((v) => v === undefined)) {
            throw new HAError("update_item needs at least one of rename, status, due_date, due_datetime, description.");
          }
          const calls = await execute([
            {
              domain: "todo",
              service: "update_item",
              opts: {
                target,
                data: { item: items[0], rename: a.rename, status: a.status, due_date: a.due_date, due_datetime: a.due_datetime, description: a.description },
              },
            },
          ]);
          return report(ha, calls, [id]);
        }
        case "remove_item": {
          const calls = await execute([{ domain: "todo", service: "remove_item", opts: { target, data: { item: items.length === 1 ? items[0] : items } } }]);
          return report(ha, calls, [id]);
        }
        default: {
          const calls = await execute([{ domain: "todo", service: "remove_completed_items", opts: { target } }]);
          return report(ha, calls, [id]);
        }
      }
    },
  );

  // ---------------------------------------------------------------- Assist

  defineTool(
    ctx,
    "ha_conversation",
    {
      title: "Talk to Home Assistant Assist",
      description:
        "Send a natural-language command or question to Home Assistant's Assist (conversation agent), exactly like typing into the Assist dialog, " +
        "and get its spoken reply. Assist can act on every entity exposed to it, so prefer the specific ha_* tools when you know the entity. " +
        "Useful for the user's own custom sentences/intents, or asking an LLM-backed agent. " +
        "Example: {text:'turn on the kitchen lights'}; {text:'what is the temperature in the bedroom?', language:'en'}. " +
        "Pass conversation_id from a previous reply to continue a multi-turn conversation.",
      inputSchema: {
        text: z.string().min(1).max(2000).describe("What to say to Assist"),
        language: z.string().max(20).optional().describe("Language code, e.g. 'en', 'he'. Default: HA's configured language"),
        agent_id: z.string().optional().describe("Conversation agent id (e.g. 'conversation.home_assistant' or an LLM agent). Default: Home Assistant's agent"),
        conversation_id: z.string().optional().describe("Continue a previous conversation"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ text, language, agent_id, conversation_id }) => {
      // Assist acts on its own, outside callService(), so blocked domains can't be
      // enforced per call. Refuse if Assist can reach any entity in a blocked domain.
      if (ha.blockedDomains.size) {
        let exposed: Record<string, Record<string, boolean>>;
        try {
          const res = await ha.ws<{ exposed_entities?: Record<string, Record<string, boolean>> }>(
            "homeassistant/expose_entity/list",
            {},
            "actions",
          );
          exposed = res?.exposed_entities ?? {};
        } catch (err) {
          throw new HAError(
            `Refusing: blocked_domains is set and the entities exposed to Assist could not be checked (${err instanceof Error ? err.message : err}).`,
          );
        }
        const hit = Object.entries(exposed)
          .filter(([id, a]) => a?.conversation === true && ha.blockedDomains.has(domainOf(id)))
          .map(([id]) => id);
        if (hit.length) {
          throw new HAError(
            `Refusing: Assist can control entities in blocked domains (${hit.slice(0, 10).join(", ")}). ` +
              "Un-expose them in Settings → Voice assistants → Expose, or use the specific ha_* tools.",
          );
        }
      }
      const r = await ha.post<any>("/api/conversation/process", { text, language, agent_id, conversation_id }, "actions");
      const resp = r?.response ?? {};
      return {
        speech: resp.speech?.plain?.speech ?? null,
        response_type: resp.response_type,
        error_code: resp.data?.code,
        success: resp.data?.success,
        failed: resp.data?.failed,
        conversation_id: r?.conversation_id,
        continue_conversation: r?.continue_conversation,
      };
    },
  );

  // ---------------------------------------------------------------- events

  const PROTECTED_EVENTS = new Set([
    "homeassistant_start",
    "homeassistant_started",
    "homeassistant_stop",
    "homeassistant_final_write",
    "homeassistant_close",
    "state_changed",
    "state_reported",
    "call_service",
    "service_registered",
    "service_removed",
    "component_loaded",
    "core_config_updated",
    "entity_registry_updated",
    "device_registry_updated",
    "area_registry_updated",
    "themes_updated",
    "user_added",
    "user_removed",
  ]);

  defineTool(
    ctx,
    "ha_fire_event",
    {
      title: "Fire an event",
      description:
        "Fire a custom event on the Home Assistant event bus, e.g. to trigger automations that listen for it. " +
        "Anything listening to the event may run, so only fire events you know the purpose of. Core system events (state_changed, homeassistant_*, call_service, …) are refused. " +
        "Example: {event_type:'my_custom_event', event_data:{room:'kitchen'}}.",
      inputSchema: {
        event_type: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, '_', '.', '-' only")
          .max(100)
          .describe("Event type, e.g. 'my_custom_event'"),
        event_data: z.record(z.unknown()).optional().describe("Event data (JSON object)"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ event_type, event_data }) => {
      if (PROTECTED_EVENTS.has(event_type.toLowerCase())) {
        throw new HAError(`Refusing to fire core system event '${event_type}'.`);
      }
      // Enforce blocked domains on any entity/area/device referenced in the event data.
      await ha.assertNotBlocked("event", { data: event_data });
      const r = await ha.post<unknown>(`/api/events/${encodeURIComponent(event_type)}`, event_data ?? {}, "actions");
      return { ok: true, event_type, result: r };
    },
  );
}
