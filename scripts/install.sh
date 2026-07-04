#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="${SUPERPOWERS_CONTROLLER_PACKAGE:-superpowers-controller}"
INSTALL_TIMEOUT_SECONDS="${SUPERPOWERS_CONTROLLER_INSTALL_TIMEOUT_SECONDS:-120}"
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
REPO_ROOT=""
if [[ -n "$SCRIPT_SOURCE" && -f "$SCRIPT_SOURCE" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  command_exists "$1" || die "$1 is required but was not found in PATH."
}

run_controller() {
  local command="$1"
  if [[ -n "$REPO_ROOT" && -f "$REPO_ROOT/package.json" && -f "$REPO_ROOT/src/cli/index.ts" ]]; then
    (cd "$REPO_ROOT" && bun run src/cli/index.ts "$command")
  else
    log "Running $PACKAGE_NAME@latest $command via bunx (timeout: ${INSTALL_TIMEOUT_SECONDS}s)..."
    set +e
    run_with_timeout bunx "$PACKAGE_NAME@latest" "$command"
    local status=$?
    set -e
    if [[ "$status" -eq 124 ]] || [[ "$status" -eq 137 ]] || [[ "$status" -eq 142 ]]; then
      printf 'error: bunx timed out after %ss while running %s@latest %s.\n' "$INSTALL_TIMEOUT_SECONDS" "$PACKAGE_NAME" "$command" >&2
      printf 'error: Bun may be unable to reach the npm registry. Retry after network recovery, or set BUN_CONFIG_REGISTRY to a reachable registry.\n' >&2
    fi
    return "$status"
  fi
}

run_with_timeout() {
  if command_exists timeout; then
    timeout "$INSTALL_TIMEOUT_SECONDS" "$@"
  elif command_exists gtimeout; then
    gtimeout "$INSTALL_TIMEOUT_SECONDS" "$@"
  elif command_exists perl; then
    perl -e 'alarm shift; exec @ARGV' "$INSTALL_TIMEOUT_SECONDS" "$@"
  else
    "$@"
  fi
}

doctor_allows_only_missing_opencode() {
  local output="$1"
  local failures
  failures="$(printf '%s\n' "$output" | grep '^fail ' | grep -v '^fail opencode: opencode executable not found$' || true)"
  [[ -z "$failures" ]]
}

opencode_plugin_cache_root() {
  local cache_home="${XDG_CACHE_HOME:-$HOME/.cache}"
  printf '%s\n' "$cache_home/opencode/packages"
}

clear_opencode_plugin_cache() {
  local cache_root
  cache_root="$(opencode_plugin_cache_root)"
  local legacy_package="opencode-superpowers-controller"
  local cache_keys=(
    "$PACKAGE_NAME"
    "$PACKAGE_NAME@latest"
    "$legacy_package"
    "$legacy_package@latest"
  )

  for key in "${cache_keys[@]}"; do
    local target="$cache_root/$key"
    if [[ -e "$target" ]]; then
      log "Removing stale OpenCode plugin cache: $target"
      rm -rf "$target"
    fi
  done

  local node_package="$cache_root/node_modules/$PACKAGE_NAME"
  if [[ -e "$node_package" ]]; then
    log "Removing stale OpenCode plugin cache: $node_package"
    rm -rf "$node_package"
  fi
}

refresh_opencode_plugin_cache() {
  if ! command_exists opencode; then
    return 0
  fi
  if [[ "${SUPERPOWERS_CONTROLLER_SKIP_OPENCODE_REFRESH:-}" == "1" ]]; then
    seed_opencode_plugin_cache_from_bunx || true
    log "Skipping OpenCode plugin cache refresh because SUPERPOWERS_CONTROLLER_SKIP_OPENCODE_REFRESH=1."
    return 0
  fi

  log "Refreshing OpenCode plugin cache..."
  clear_opencode_plugin_cache
  if seed_opencode_plugin_cache_from_bunx; then
    return 0
  fi
  set +e
  run_with_timeout opencode plugin "$PACKAGE_NAME" --global --force
  local status=$?
  set -e
  if [[ "$status" -eq 124 ]] || [[ "$status" -eq 137 ]] || [[ "$status" -eq 142 ]]; then
    printf 'error: OpenCode plugin refresh timed out after %ss while installing %s.\n' "$INSTALL_TIMEOUT_SECONDS" "$PACKAGE_NAME" >&2
    printf 'error: Config files were written, but OpenCode could not refresh its plugin cache. Retry later, or set SUPERPOWERS_CONTROLLER_SKIP_OPENCODE_REFRESH=1 to skip this step.\n' >&2
  fi
  return "$status"
}

seed_opencode_plugin_cache_from_bunx() {
  local temp_root="${TMPDIR:-/tmp}"
  temp_root="${temp_root%/}"
  local bunx_root="$temp_root/bunx-$(id -u)-$PACKAGE_NAME@latest"
  local source_modules="$bunx_root/node_modules"
  local source_package="$source_modules/$PACKAGE_NAME/package.json"
  if [[ ! -f "$source_package" ]]; then
    return 1
  fi

  local cache_root
  cache_root="$(opencode_plugin_cache_root)"
  mkdir -p "$cache_root/node_modules"
  cp -R "$source_modules/." "$cache_root/node_modules/"
  CACHE_ROOT="$cache_root" PACKAGE_NAME="$PACKAGE_NAME" bun --eval '
const fs = require("fs")
const path = require("path")
const cacheRoot = process.env.CACHE_ROOT
const packageName = process.env.PACKAGE_NAME
const target = path.join(cacheRoot, "package.json")
const current = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {}
current.dependencies = { ...(current.dependencies ?? {}), [packageName]: "latest" }
for (const legacyName of ["oh-my-openagent", "oh-my-opencode", "opencode-superpowers-controller"]) {
  delete current.dependencies[legacyName]
}
fs.writeFileSync(target, JSON.stringify(current, null, 2) + "\n")
'
  log "Seeded OpenCode plugin cache from bunx package cache: $source_modules"
}

ensure_tui_plugin_config() {
  local config_dir="$HOME/.config/opencode"
  local tui_entry="$PACKAGE_NAME/tui"

  mkdir -p "$config_dir"
  CONFIG_DIR="$config_dir" TUI_PACKAGE_ENTRY="$tui_entry" bun --eval '
const fs = require("fs")
const path = require("path")

const configDir = process.env.CONFIG_DIR
const entry = process.env.TUI_PACKAGE_ENTRY
const jsoncPath = path.join(configDir, "tui.jsonc")
const jsonPath = path.join(configDir, "tui.json")
const target = fs.existsSync(jsoncPath) || !fs.existsSync(jsonPath) ? jsoncPath : jsonPath
let content = fs.existsSync(target)
  ? fs.readFileSync(target, "utf8")
  : "{\n  \"$schema\": \"https://opencode.ai/tui.json\"\n}\n"

if (!content.includes(entry)) {
  if (/"plugin"\s*:\s*\[/.test(content)) {
    content = content.replace(/("plugin"\s*:\s*\[)([\s\S]*?)(\])/m, (_match, start, body, end) => {
      const needsComma = body.trim().length > 0 && !body.trimEnd().endsWith(",")
      return `${start}${body}${needsComma ? ", " : ""}"${entry}"${end}`
    })
  } else {
    content = content.replace(/\}\s*$/, `,\n  "plugin": ["${entry}"]\n}\n`)
  }
}

if (!content.includes("\"$schema\"")) {
  content = content.replace(/\{\s*/, "{\n  \"$schema\": \"https://opencode.ai/tui.json\",\n  ")
}

fs.writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`)
console.log(`Installed OpenCode TUI plugin entry:\n${target}`)
'
}

main() {
  require_command bash
  require_command bun

  if ! command_exists opencode; then
    log "warning: opencode was not found in PATH. The plugin can be installed now, but OpenCode must be installed before use."
  fi

  log "Installing Superpowers Controller..."
  if ! run_controller install; then
    die "install command failed"
  fi

  ensure_tui_plugin_config

  if ! refresh_opencode_plugin_cache; then
    die "failed to refresh OpenCode plugin cache"
  fi

  log ""
  log "Running doctor..."
  local doctor_output
  local doctor_status=0
  local doctor_capture
  doctor_capture="$(mktemp)"
  set +e
  run_controller doctor 2>&1 | tee "$doctor_capture"
  doctor_status="${PIPESTATUS[0]}"
  set -e
  doctor_output="$(cat "$doctor_capture")"
  rm -f "$doctor_capture"

  if [[ "$doctor_status" -ne 0 ]] && ! doctor_allows_only_missing_opencode "$doctor_output"; then
    die "doctor reported failed checks"
  fi

  log ""
  if [[ "$doctor_status" -ne 0 ]]; then
    log "Installed with warning: install OpenCode, then run: bunx $PACKAGE_NAME doctor"
  else
    log "Superpowers Controller installed."
  fi
  log "Validate OpenCode can see the agent with: opencode agent list"
  log "Validate TUI config with: test -f ~/.config/opencode/tui.json -o -f ~/.config/opencode/tui.jsonc"
  log "Restart OpenCode after installation so the TUI plugin is loaded."
  log "Start with: opencode --agent super-agent"
}

main "$@"
