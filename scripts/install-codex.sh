#!/usr/bin/env bash
set -euo pipefail

# Online / local installer for the Codex weak-enhancement agents adapter.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install-codex.sh | bash
#   bash scripts/install-codex.sh

REPO_SLUG="${SUPERPOWERS_CONTROLLER_REPO:-goodjin/superpowers-controller}"
REPO_REF="${SUPERPOWERS_CONTROLLER_REF:-main}"
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
REPO_ROOT=""
CLEANUP_DIR=""

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

cleanup() {
  if [[ -n "$CLEANUP_DIR" && -d "$CLEANUP_DIR" ]]; then
    rm -rf "$CLEANUP_DIR"
  fi
}

trap cleanup EXIT

resolve_node() {
  if command_exists node; then
    printf 'node\n'
    return 0
  fi
  if command_exists bun; then
    printf 'bun\n'
    return 0
  fi
  die "node or bun is required to run the Codex agent installer."
}

adapter_ready() {
  local root="$1"
  [[ -f "$root/adapters/codex/scripts/install.mjs" && -d "$root/adapters/codex/agents" ]]
}

download_adapter_tree() {
  require_command curl
  require_command tar
  require_command mktemp

  CLEANUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sp-codex-install.XXXXXX")"
  local archive="$CLEANUP_DIR/repo.tar.gz"
  local extract_root="$CLEANUP_DIR/extract"
  mkdir -p "$extract_root"

  local url="https://codeload.github.com/${REPO_SLUG}/tar.gz/${REPO_REF}"
  log "Downloading Codex adapter from ${REPO_SLUG}@${REPO_REF}..."
  if ! curl -fsSL "$url" -o "$archive"; then
    die "failed to download ${url}"
  fi

  # GitHub tarballs use <repo>-<ref>/... ; ref may contain slashes for tags.
  if ! tar -xzf "$archive" -C "$extract_root"; then
    die "failed to extract downloaded archive"
  fi

  local found=""
  found="$(find "$extract_root" -type f -path '*/adapters/codex/scripts/install.mjs' | head -n 1 || true)"
  [[ -n "$found" ]] || die "downloaded archive does not contain adapters/codex"

  local adapter_scripts_dir
  adapter_scripts_dir="$(cd "$(dirname "$found")" && pwd)"
  printf '%s\n' "$(cd "$adapter_scripts_dir/../.." && pwd)"
}

main() {
  require_command bash

  local runtime
  runtime="$(resolve_node)"
  log "Using runtime: $runtime"

  local checkout=""
  if [[ -n "$REPO_ROOT" ]] && adapter_ready "$REPO_ROOT"; then
    checkout="$REPO_ROOT"
    log "Using local checkout: $checkout"
  else
    checkout="$(download_adapter_tree)"
    log "Using downloaded adapter tree: $checkout"
  fi

  local installer="$checkout/adapters/codex/scripts/install.mjs"
  [[ -f "$installer" ]] || die "installer not found: $installer"

  log "Installing Superpowers Codex agents..."
  if ! (cd "$checkout" && "$runtime" "$installer"); then
    die "Codex agent install failed"
  fi

  log ""
  log "Superpowers Codex agents installed."
  log "This does not change Codex's default session agent."
  log "In Codex, spawn or select: superpowers-agent"
  log "Optional: install official Superpowers skills from the Codex plugin directory."
  log "Uninstall: bash scripts/uninstall-codex.sh"
  log "  or: curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/${REPO_REF}/scripts/uninstall-codex.sh | bash"
}

main "$@"
