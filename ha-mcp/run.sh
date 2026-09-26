#!/bin/sh
# Entrypoint. Inside Home Assistant (add-on) it maps /data/options.json to env
# vars; outside HA (plain Docker) it just starts the server with the env as-is.
set -e

DATA_DIR="${DATA_DIR:-/data}"
OPTS="$DATA_DIR/options.json"

opt() {
  jq -r --arg k "$1" 'if has($k) and .[$k] != null then .[$k] | tostring else "" end' "$OPTS"
}

if [ -f "$OPTS" ]; then
  echo "[ha-mcp] Running as a Home Assistant add-on"

  LLAT=$(opt ha_token)
  if [ -n "$LLAT" ]; then
    export HA_URL="http://homeassistant:8123"
    export HA_TOKEN="$LLAT"
    echo "[ha-mcp] Using the long-lived access token from the add-on options"
  else
    export HA_URL="http://supervisor/core"
    export HA_TOKEN="$SUPERVISOR_TOKEN"
    echo "[ha-mcp] Using the Supervisor token (no long-lived token needed)"
  fi

  TOKEN=$(opt auth_token)
  if [ -z "$TOKEN" ]; then
    if [ ! -s "$DATA_DIR/auth_token" ]; then
      head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$DATA_DIR/auth_token"
      chmod 600 "$DATA_DIR/auth_token"
      echo "[ha-mcp] Generated a new auth token (stored in the add-on's /data)"
    fi
    TOKEN=$(cat "$DATA_DIR/auth_token")
  fi
  export MCP_AUTH_TOKEN="$TOKEN"

  TPL=$(opt enable_template_tool)
  export ENABLE_TEMPLATE_TOOL="${TPL:-true}"
  export MCP_TRANSPORT=http
  export PORT=3000
  export HOST=0.0.0.0

  echo "[ha-mcp] ------------------------------------------------------------"
  echo "[ha-mcp] claude.ai connector URL:  https://<your-cloudflare-host>/mcp/${TOKEN}"
  echo "[ha-mcp] Keep this URL secret. Set 'auth_token' in the options to change it."
  echo "[ha-mcp] ------------------------------------------------------------"
fi

exec node "${APP_DIR:-/app}/dist/index.js"
