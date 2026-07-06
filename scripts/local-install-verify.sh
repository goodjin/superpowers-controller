#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log() {
  printf '%s\n' "$*"
}

now_ms() {
  if command_exists perl; then
    perl -MTime::HiRes=time -e 'printf "%.0f", time() * 1000'
  else
    bun --eval 'process.stdout.write(String(Date.now()))'
  fi
}

elapsed_ms() {
  local start="$1"
  local end
  end="$(now_ms)"
  printf '%s\n' "$((end - start))"
}

log_timing() {
  local label="$1"
  local start="$2"
  log "[timing] $label: $(elapsed_ms "$start")ms"
}

run_timed() {
  local label="$1"
  shift
  local start
  local status
  start="$(now_ms)"
  set +e
  "$@"
  status=$?
  set -e
  log_timing "$label" "$start"
  return "$status"
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

main() {
  require_command bash
  require_command bun
  local total_start
  total_start="$(now_ms)"

  cd "$REPO_ROOT"

  log "Local Superpowers Controller install verify"
  log "Repo: $REPO_ROOT"
  log ""

  if [[ "${SUPERPOWERS_CONTROLLER_LOCAL_SKIP_TESTS:-}" == "1" ]]; then
    log "Skipping focused tests because SUPERPOWERS_CONTROLLER_LOCAL_SKIP_TESTS=1."
  else
    log "Running focused install and TUI tests..."
    run_timed "focused tests" bun test test/install.test.ts test/tui-plugin.test.ts
  fi

  log ""
  log "Building local package..."
  run_timed "build" bun run build

  log ""
  log "Installing current checkout into OpenCode..."
  run_timed "local install script" bash "$SCRIPT_DIR/install.sh"

  log ""
  log "Local install verification complete."
  log "Restart OpenCode so the refreshed TUI plugin is loaded."
  log_timing "local install verify total" "$total_start"
}

main "$@"
