#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RUNTIME_ROOT="${SUPERAGENT_ROOT:-$HOME/.local/share/superpowers-controller-test}"
PORT="${SUPERAGENT_PORT:-5096}"
HOSTNAME="${SUPERAGENT_HOSTNAME:-127.0.0.1}"
BIN_DIR="$RUNTIME_ROOT/bin"
ISOLATED_HOME="$RUNTIME_ROOT/home"
CONFIG_DIR="$ISOLATED_HOME/.config/opencode"
DATA_DIR="$ISOLATED_HOME/.local/share/opencode"
PROJECT_DIR="$RUNTIME_ROOT/project"
PID_FILE="$RUNTIME_ROOT/superagent.pid"
LOG_FILE="$RUNTIME_ROOT/superagent.log"
OPENCODE_BIN="$REPO_ROOT/tools/opencode-1.16.2/node_modules/.bin/opencode"
LAUNCHER="$HOME/.local/bin/superagent"

ACTION="${1:-restart}"

build_plugin() {
  (cd "$REPO_ROOT" && bun run build)
}

write_isolated_config() {
  mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$PROJECT_DIR"

  node <<'NODE'
const fs = require("fs")
const home = process.env.HOME
const repoRoot = process.env.REPO_ROOT
const configDir = process.env.CONFIG_DIR
const sourcePath = `${home}/.config/opencode/opencode.json`
const targetPath = `${configDir}/opencode.json`
const tuiTargetPath = `${configDir}/tui.json`

const target = {
  $schema: "https://opencode.ai/config.json",
  plugin: [`file://${repoRoot}/dist/index.js`],
  permission: "allow",
}

if (fs.existsSync(sourcePath)) {
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"))
  target.disabled_providers = source.disabled_providers ?? []
  if (source.model) target.model = source.model
  if (source.small_model) target.small_model = source.small_model
  for (const name of ["minimax-cn-coding-plan", "minimaxi-ultra"]) {
    if (source.provider?.[name]) {
      target.provider ??= {}
      target.provider[name] = source.provider[name]
    }
  }
}

fs.writeFileSync(targetPath, JSON.stringify(target, null, 2) + "\n")
fs.writeFileSync(
  tuiTargetPath,
  JSON.stringify(
    {
      $schema: "https://opencode.ai/tui.json",
      plugin: [`file://${repoRoot}/dist/tui.js`],
    },
    null,
    2,
  ) + "\n",
)
NODE

  if [[ -f "$HOME/.local/share/opencode/auth.json" ]]; then
    cp "$HOME/.local/share/opencode/auth.json" "$DATA_DIR/auth.json"
    chmod 600 "$DATA_DIR/auth.json"
  fi
}

sync_skills() {
  mkdir -p "$CONFIG_DIR/skills"
  rsync -a --delete "$REPO_ROOT/assets/skills/" "$CONFIG_DIR/skills/"
}

write_launchers() {
  mkdir -p "$BIN_DIR" "$HOME/.local/bin"

  cat > "$BIN_DIR/opencode" <<SH
#!/usr/bin/env bash
set -euo pipefail
export HOME="$ISOLATED_HOME"
export XDG_CONFIG_HOME="$ISOLATED_HOME/.config"
exec "$OPENCODE_BIN" "\$@"
SH
  chmod +x "$BIN_DIR/opencode"

  cat > "$LAUNCHER" <<SH
#!/usr/bin/env bash
set -euo pipefail
ROOT="\${SUPERAGENT_ROOT:-$RUNTIME_ROOT}"
PORT="\${SUPERAGENT_PORT:-$PORT}"
HOSTNAME="\${SUPERAGENT_HOSTNAME:-$HOSTNAME}"
PROJECT_DIR="\${SUPERAGENT_PROJECT_DIR:-\$PWD}"
DEPLOY_SCRIPT="$REPO_ROOT/scripts/deploy-superagent-runtime.sh"
case "\${1:-}" in
  start|stop|restart|status)
    exec "\$DEPLOY_SCRIPT" "\$1"
    ;;
esac
export HOME="\$ROOT/home"
export XDG_CONFIG_HOME="\$ROOT/home/.config"
if [[ \$# -eq 0 ]]; then
  mkdir -p "\$PROJECT_DIR"
  exec "$OPENCODE_BIN" "\$PROJECT_DIR" --agent "superpowers-agent"
fi
exec "$OPENCODE_BIN" "\$@"
SH
  chmod +x "$LAUNCHER"
}

stop_server() {
  local pid
  pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE")"
  fi

  if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
    pid=""
  fi

  if [[ -z "$pid" ]]; then
    pid="$(listener_pid || true)"
  fi

  terminate_pid "$pid"

  local listener
  listener="$(listener_pid || true)"
  if [[ -n "$listener" ]] && [[ "$listener" != "$pid" ]]; then
    terminate_pid "$listener"
  fi

  rm -f "$PID_FILE"
}

terminate_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in {1..30}; do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
}

start_server() {
  mkdir -p "$RUNTIME_ROOT"
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $PORT is already in use. Stop that process or set SUPERAGENT_PORT." >&2
    return 1
  fi

  (
    cd "$PROJECT_DIR"
    export HOME="$ISOLATED_HOME"
    export XDG_CONFIG_HOME="$ISOLATED_HOME/.config"
    nohup "$OPENCODE_BIN" serve --hostname "$HOSTNAME" --port "$PORT" --print-logs --log-level INFO > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
  )

  local listener
  for _ in {1..50}; do
    listener="$(listener_pid || true)"
    if [[ -n "$listener" ]]; then
      echo "$listener" > "$PID_FILE"
      break
    fi
    sleep 0.2
  done

  if [[ -z "${listener:-}" ]] || [[ ! -f "$PID_FILE" ]] || ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Superagent failed to start. Log: $LOG_FILE" >&2
    tail -n 80 "$LOG_FILE" >&2 || true
    return 1
  fi

  if ! wait_for_assets; then
    stop_server
    return 1
  fi

  listener="$(listener_pid || true)"
  if [[ -z "$listener" ]] || ! kill -0 "$listener" 2>/dev/null; then
    echo "Superagent assets became ready, but the server is no longer listening. Log: $LOG_FILE" >&2
    tail -n 80 "$LOG_FILE" >&2 || true
    stop_server
    return 1
  fi
  echo "$listener" > "$PID_FILE"
}

listener_pid() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN | head -n 1
}

wait_for_assets() {
  for _ in {1..50}; do
    local html
    html="$(curl -fsS --max-time 2 "http://$HOSTNAME:$PORT/" 2>/dev/null || true)"
    if [[ "$html" == *"/assets/index-"* ]]; then
      local entry
      entry="$(printf '%s' "$html" | grep -oE 'src="/assets/index-[^"]+\.js"' | head -n 1 | sed 's/^src="//; s/"$//')"
      if [[ -n "$entry" ]]; then
        local bytes
        bytes="$(curl -fsS --max-time 3 "http://$HOSTNAME:$PORT$entry" 2>/dev/null | wc -c | tr -d ' ')"
        if [[ "${bytes:-0}" -gt 1000 ]]; then
          return 0
        fi
      fi
    fi
    sleep 0.2
  done

  echo "Superagent started, but Web assets did not become ready in time. Log: $LOG_FILE" >&2
  return 1
}

verify_runtime() {
  "$LAUNCHER" --version
  "$LAUNCHER" agent list | grep -E '^(superpowers-agent|sp-)' >/dev/null
}

deploy() {
  build_plugin
  REPO_ROOT="$REPO_ROOT" CONFIG_DIR="$CONFIG_DIR" write_isolated_config
  sync_skills
  write_launchers
  verify_runtime >/dev/null
}

case "$ACTION" in
  deploy)
    deploy
    echo "Superagent deployed. Launcher: $LAUNCHER"
    ;;
  start)
    deploy
    start_server
    echo "Superagent running at http://$HOSTNAME:$PORT"
    echo "Log: $LOG_FILE"
    ;;
  stop)
    stop_server
    echo "Superagent stopped."
    ;;
  restart)
    deploy
    stop_server
    start_server
    echo "Superagent restarted at http://$HOSTNAME:$PORT"
    echo "Launcher: $LAUNCHER"
    echo "Log: $LOG_FILE"
    ;;
  status)
    listener="$(listener_pid || true)"
    if [[ -n "$listener" ]] && kill -0 "$listener" 2>/dev/null; then
      echo "$listener" > "$PID_FILE"
      echo "Superagent running at http://$HOSTNAME:$PORT (pid $listener)"
    else
      echo "Superagent not running."
    fi
    ;;
  *)
    echo "Usage: $0 [deploy|start|stop|restart|status]" >&2
    exit 2
    ;;
esac
