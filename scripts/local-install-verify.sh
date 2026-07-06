#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

main() {
  require_command bash
  require_command bun

  cd "$REPO_ROOT"

  log "Local Superpowers Controller install verify"
  log "Repo: $REPO_ROOT"
  log ""

  if [[ "${SUPERPOWERS_CONTROLLER_LOCAL_SKIP_TESTS:-}" == "1" ]]; then
    log "Skipping focused tests because SUPERPOWERS_CONTROLLER_LOCAL_SKIP_TESTS=1."
  else
    log "Running focused install and TUI tests..."
    bun test test/install.test.ts test/tui-plugin.test.ts
  fi

  log ""
  log "Building local package..."
  bun run build

  log ""
  log "Installing current checkout into OpenCode..."
  bash "$SCRIPT_DIR/install.sh"

  log ""
  log "Local install verification complete."
  log "Restart OpenCode so the refreshed TUI plugin is loaded."
}

main "$@"
