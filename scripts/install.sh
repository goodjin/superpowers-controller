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

prune_opencode_plugin_cache_manifest() {
  local cache_root
  cache_root="$(opencode_plugin_cache_root)"
  local manifest="$cache_root/package.json"
  if [[ ! -f "$manifest" ]]; then
    return 0
  fi

  CACHE_PACKAGE_JSON="$manifest" PACKAGE_NAME="$PACKAGE_NAME" bun --eval '
const fs = require("fs")
const target = process.env.CACHE_PACKAGE_JSON
const packageName = process.env.PACKAGE_NAME
const packageSections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

try {
  const pkg = JSON.parse(fs.readFileSync(target, "utf8"))
  let changed = false
  for (const section of packageSections) {
    const deps = pkg[section]
    if (!deps || typeof deps !== "object") continue
    if (Object.prototype.hasOwnProperty.call(deps, packageName)) {
      delete deps[packageName]
      changed = true
    }
    if (Object.keys(deps).length === 0) delete pkg[section]
  }
  if (changed) {
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [packageName]: "latest" }
    fs.writeFileSync(target, JSON.stringify(pkg, null, 2) + "\n")
    console.log(`Pruned stale OpenCode plugin cache manifest: ${target}`)
  }
} catch {
}
'
}

clear_opencode_plugin_cache() {
  local cache_root
  cache_root="$(opencode_plugin_cache_root)"
  local cache_keys=(
    "$PACKAGE_NAME"
    "$PACKAGE_NAME@latest"
  )

  for key in "${cache_keys[@]}"; do
    local target="$cache_root/$key"
    if [[ -e "$target" ]]; then
      log "Removing stale OpenCode plugin cache: $target"
      rm -rf "$target"
    fi
  done

  local node_packages=(
    "$PACKAGE_NAME"
  )
  for package in "${node_packages[@]}"; do
    local node_package="$cache_root/node_modules/$package"
    if [[ -e "$node_package" ]]; then
      log "Removing stale OpenCode plugin cache: $node_package"
      rm -rf "$node_package"
    fi
  done

  local bin_names=("$PACKAGE_NAME")
  for bin_name in "${bin_names[@]}"; do
    local bin_path="$cache_root/node_modules/.bin/$bin_name"
    if [[ -e "$bin_path" || -L "$bin_path" ]]; then
      log "Removing stale OpenCode plugin cache: $bin_path"
      rm -f "$bin_path"
    fi
  done

  prune_opencode_plugin_cache_manifest
}

cleanup_bunx_plugin_cache() {
  local temp_root="${TMPDIR:-/tmp}"
  temp_root="${temp_root%/}"
  local uid
  uid="$(id -u)"
  if [[ -z "$REPO_ROOT" || ! -f "$REPO_ROOT/package.json" || ! -f "$REPO_ROOT/src/cli/index.ts" ]]; then
    return 0
  fi

  local target="$temp_root/bunx-$uid-$PACKAGE_NAME@latest"
  if [[ -e "$target" ]]; then
    log "Removing stale bunx plugin cache: $target"
    rm -rf "$target"
  fi
}

cleanup_user_tui_plugin_dependency_state() {
  local config_dirs=(
    "$HOME/.config/opencode"
    "$HOME/.opencode"
  )

  USER_OPENCODE_CONFIG_DIRS="$(IFS=:; printf '%s' "${config_dirs[*]}")" bun --eval '
const fs = require("fs")
const path = require("path")

const ownedNames = [
  "superpowers-controller",
]
const packageSections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

function removeIfExists(target) {
  if (!fs.existsSync(target)) return false
  fs.rmSync(target, { recursive: true, force: true })
  return true
}

function removeEmptySections(pkg) {
  for (const section of packageSections) {
    if (pkg[section] && Object.keys(pkg[section]).length === 0) delete pkg[section]
  }
}

function hasDependencySections(pkg) {
  return packageSections.some((section) => pkg[section] && Object.keys(pkg[section]).length > 0)
}

function cleanupConfigDir(configDir) {
  if (!configDir || !fs.existsSync(configDir)) return
  const packagePath = path.join(configDir, "package.json")
  const lockPaths = [
    path.join(configDir, "package-lock.json"),
    path.join(configDir, "bun.lock"),
    path.join(configDir, "bun.lockb"),
  ]
  const nodeModulesPath = path.join(configDir, "node_modules")
  let removedDependency = false
  let removeWholeNodeModules = false

  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"))
      for (const section of packageSections) {
        const deps = pkg[section]
        if (!deps || typeof deps !== "object") continue
        for (const name of ownedNames) {
          if (Object.prototype.hasOwnProperty.call(deps, name)) {
            delete deps[name]
            removedDependency = true
          }
        }
      }
      removeEmptySections(pkg)
      if (!hasDependencySections(pkg)) {
        fs.rmSync(packagePath, { force: true })
        removeWholeNodeModules = true
      } else if (removedDependency) {
        fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n")
      }
    } catch {
      return
    }
  }

  let removedArtifact = false
  if (removeWholeNodeModules) {
    removedArtifact = removeIfExists(nodeModulesPath) || removedArtifact
  } else {
    for (const name of ownedNames) {
      removedArtifact = removeIfExists(path.join(nodeModulesPath, ...name.split("/"))) || removedArtifact
    }
  }
  if (removedDependency || removedArtifact) {
    for (const lockPath of lockPaths) removeIfExists(lockPath)
    console.log(`Removed stale OpenCode user plugin dependency state: ${configDir}`)
  }
}

for (const configDir of (process.env.USER_OPENCODE_CONFIG_DIRS ?? "").split(":")) {
  cleanupConfigDir(configDir)
}
'
}

refresh_opencode_plugin_cache() {
  if ! command_exists opencode; then
    return 0
  fi
  if [[ "${SUPERPOWERS_CONTROLLER_SKIP_OPENCODE_REFRESH:-}" == "1" ]]; then
    run_timed "OpenCode cache seed from local checkout" seed_opencode_plugin_cache_from_local_checkout \
      || run_timed "OpenCode cache seed from bunx" seed_opencode_plugin_cache_from_bunx \
      || true
    log "Skipping OpenCode plugin cache refresh because SUPERPOWERS_CONTROLLER_SKIP_OPENCODE_REFRESH=1."
    return 0
  fi

  log "Refreshing OpenCode plugin cache..."
  run_timed "OpenCode plugin cache cleanup" clear_opencode_plugin_cache
  if run_timed "OpenCode cache seed from local checkout" seed_opencode_plugin_cache_from_local_checkout; then
    return 0
  fi
  if run_timed "OpenCode cache seed from bunx" seed_opencode_plugin_cache_from_bunx; then
    return 0
  fi
  local start
  start="$(now_ms)"
  set +e
  run_with_timeout opencode plugin "$PACKAGE_NAME" --global --force
  local status=$?
  set -e
  log_timing "OpenCode plugin refresh command" "$start"
  if [[ "$status" -eq 124 ]] || [[ "$status" -eq 137 ]] || [[ "$status" -eq 142 ]]; then
    printf 'error: OpenCode plugin refresh timed out after %ss while installing %s.\n' "$INSTALL_TIMEOUT_SECONDS" "$PACKAGE_NAME" >&2
    printf 'error: Config files were written, but OpenCode could not refresh its plugin cache. Retry later, or set SUPERPOWERS_CONTROLLER_SKIP_OPENCODE_REFRESH=1 to skip this step.\n' >&2
  fi
  return "$status"
}

local_package_version() {
  local package_json="$1/package.json"
  PACKAGE_JSON="$package_json" bun --eval '
const fs = require("fs")
try {
  const pkg = JSON.parse(fs.readFileSync(process.env.PACKAGE_JSON, "utf8"))
  process.stdout.write(String(pkg.version || "latest"))
} catch {
  process.stdout.write("latest")
}
'
}

write_opencode_package_cache_manifest() {
  local cache_dir="$1"
  local version_spec="$2"
  mkdir -p "$cache_dir"
  CACHE_DIR="$cache_dir" PACKAGE_NAME="$PACKAGE_NAME" VERSION_SPEC="$version_spec" bun --eval '
const fs = require("fs")
const path = require("path")
const cacheDir = process.env.CACHE_DIR
const packageName = process.env.PACKAGE_NAME
const versionSpec = process.env.VERSION_SPEC
const target = path.join(cacheDir, "package.json")
fs.writeFileSync(target, JSON.stringify({ dependencies: { [packageName]: versionSpec } }, null, 2) + "\n")
'
}

write_opencode_root_cache_manifest() {
  local cache_root="$1"
  mkdir -p "$cache_root"
  CACHE_ROOT="$cache_root" PACKAGE_NAME="$PACKAGE_NAME" bun --eval '
const fs = require("fs")
const path = require("path")
const cacheRoot = process.env.CACHE_ROOT
const packageName = process.env.PACKAGE_NAME
const target = path.join(cacheRoot, "package.json")
const current = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {}
current.dependencies = { ...(current.dependencies ?? {}), [packageName]: "latest" }
fs.writeFileSync(target, JSON.stringify(current, null, 2) + "\n")
'
}

copy_local_checkout_package_to() {
  local target_package="$1"
  rm -rf "$target_package"
  mkdir -p "$target_package"

  cp "$REPO_ROOT/package.json" "$target_package/package.json"
  [[ -f "$REPO_ROOT/README.md" ]] && cp "$REPO_ROOT/README.md" "$target_package/README.md"
  [[ -f "$REPO_ROOT/LICENSE" ]] && cp "$REPO_ROOT/LICENSE" "$target_package/LICENSE"
  cp -R "$REPO_ROOT/dist" "$target_package/dist"
  cp -R "$REPO_ROOT/assets" "$target_package/assets"
  mkdir -p "$target_package/scripts"
  cp "$REPO_ROOT/scripts/install.sh" "$target_package/scripts/install.sh"
}

# OpenCode loads the npm package from cache and resolves imports relative to that
# package. A dist-only seed without node_modules breaks `@opencode-ai/plugin/tool`,
# so agent injection never runs and default_agent falls back to build.
seeded_package_has_runtime_deps() {
  local target_package="$1"
  [[ -f "$target_package/node_modules/@opencode-ai/plugin/package.json" ]] || return 1
  [[ -f "$target_package/node_modules/@opencode-ai/plugin/dist/tool.js" ]] || return 1
  return 0
}

install_seeded_package_dependencies() {
  local target_package="$1"
  if [[ ! -f "$target_package/package.json" ]]; then
    printf 'error: cannot install plugin dependencies; missing package.json at %s\n' "$target_package" >&2
    return 1
  fi

  log "Installing production dependencies for seeded OpenCode plugin package: $target_package"
  local start
  start="$(now_ms)"
  set +e
  (
    cd "$target_package"
    bun install --production
  )
  local status=$?
  set -e
  log_timing "seeded plugin bun install --production" "$start"
  if [[ "$status" -ne 0 ]]; then
    printf 'error: bun install --production failed for seeded plugin package %s\n' "$target_package" >&2
    return "$status"
  fi
  if ! seeded_package_has_runtime_deps "$target_package"; then
    printf 'error: seeded plugin package %s is missing @opencode-ai/plugin (tool entry). OpenCode will not load superpowers agents.\n' "$target_package" >&2
    return 1
  fi
  return 0
}

copy_seeded_package_node_modules() {
  local source_package="$1"
  local target_package="$2"
  rm -rf "$target_package/node_modules"
  cp -R "$source_package/node_modules" "$target_package/node_modules"
  if [[ -f "$source_package/bun.lock" ]]; then
    cp "$source_package/bun.lock" "$target_package/bun.lock"
  fi
  if ! seeded_package_has_runtime_deps "$target_package"; then
    printf 'error: copied plugin node_modules into %s but @opencode-ai/plugin/tool is still missing\n' "$target_package" >&2
    return 1
  fi
}

seed_opencode_plugin_cache_from_local_checkout() {
  if [[ -z "$REPO_ROOT" || ! -f "$REPO_ROOT/package.json" || ! -f "$REPO_ROOT/dist/index.js" || ! -f "$REPO_ROOT/dist/tui.js" ]]; then
    return 1
  fi

  local cache_root
  cache_root="$(opencode_plugin_cache_root)"
  local version_spec
  version_spec="$(local_package_version "$REPO_ROOT")"
  mkdir -p "$cache_root/node_modules"

  local root_target="$cache_root/node_modules/$PACKAGE_NAME"
  copy_local_checkout_package_to "$root_target"
  install_seeded_package_dependencies "$root_target" || return 1
  write_opencode_root_cache_manifest "$cache_root"
  log "Seeded OpenCode root package cache from local checkout: $root_target"

  local cache_keys=("$PACKAGE_NAME" "$PACKAGE_NAME@latest")
  for key in "${cache_keys[@]}"; do
    local key_dir="$cache_root/$key"
    local key_target="$key_dir/node_modules/$PACKAGE_NAME"
    mkdir -p "$key_dir/node_modules"
    copy_local_checkout_package_to "$key_target"
    copy_seeded_package_node_modules "$root_target" "$key_target" || return 1
    write_opencode_package_cache_manifest "$key_dir" "$version_spec"
    log "Seeded OpenCode package-key cache from local checkout: $key_target"
  done
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
  write_opencode_root_cache_manifest "$cache_root"

  local version_spec
  version_spec="$(local_package_version "$source_modules/$PACKAGE_NAME")"
  local root_target="$cache_root/node_modules/$PACKAGE_NAME"
  if ! seeded_package_has_runtime_deps "$root_target"; then
    install_seeded_package_dependencies "$root_target" || return 1
  fi

  local cache_keys=("$PACKAGE_NAME" "$PACKAGE_NAME@latest")
  for key in "${cache_keys[@]}"; do
    local key_dir="$cache_root/$key"
    local key_target="$key_dir/node_modules/$PACKAGE_NAME"
    rm -rf "$key_target"
    mkdir -p "$key_dir/node_modules"
    cp -R "$source_modules/$PACKAGE_NAME" "$key_target"
    if ! seeded_package_has_runtime_deps "$key_target"; then
      if seeded_package_has_runtime_deps "$root_target"; then
        copy_seeded_package_node_modules "$root_target" "$key_target" || return 1
      else
        install_seeded_package_dependencies "$key_target" || return 1
      fi
    fi
    write_opencode_package_cache_manifest "$key_dir" "$version_spec"
  done
  log "Seeded OpenCode plugin cache from bunx package cache: $source_modules"
}

ensure_tui_plugin_config() {
  local config_dir="$HOME/.config/opencode"
  # OpenCode resolves exports["./tui"] from the npm package name.
  # "package/tui" is parsed as GitHub owner/repo and hangs on git ls-remote.
  local tui_entry="$PACKAGE_NAME"
  local legacy_tui_entry="$PACKAGE_NAME/tui"

  mkdir -p "$config_dir"
  CONFIG_DIR="$config_dir" TUI_PACKAGE_ENTRY="$tui_entry" LEGACY_TUI_PACKAGE_ENTRY="$legacy_tui_entry" bun --eval '
const fs = require("fs")
const path = require("path")

const configDir = process.env.CONFIG_DIR
const entry = process.env.TUI_PACKAGE_ENTRY
const legacyEntry = process.env.LEGACY_TUI_PACKAGE_ENTRY
const jsoncPath = path.join(configDir, "tui.jsonc")
const jsonPath = path.join(configDir, "tui.json")
const target = fs.existsSync(jsoncPath) || !fs.existsSync(jsonPath) ? jsoncPath : jsonPath
let content = fs.existsSync(target)
  ? fs.readFileSync(target, "utf8")
  : "{\n  \"$schema\": \"https://opencode.ai/tui.json\"\n}\n"

if (/"plugin"\s*:\s*\[/.test(content)) {
  content = content.replace(/("plugin"\s*:\s*\[)([\s\S]*?)(\])/m, (_match, start, body, end) => {
    const plugins = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== legacyEntry)
    if (!plugins.includes(entry)) plugins.push(entry)
    return `${start}${plugins.map((p) => `"${p}"`).join(", ")}${end}`
  })
} else {
  content = content.replace(/\}\s*$/, `,\n  "plugin": ["${entry}"]\n}\n`)
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
  local total_start
  total_start="$(now_ms)"

  if ! command_exists opencode; then
    log "warning: opencode was not found in PATH. The plugin can be installed now, but OpenCode must be installed before use."
  fi

  log "Installing Superpowers Controller..."
  if ! run_timed "controller install" run_controller install; then
    die "install command failed"
  fi

  run_timed "TUI plugin config" ensure_tui_plugin_config
  run_timed "stale user plugin dependency cleanup" cleanup_user_tui_plugin_dependency_state
  run_timed "stale bunx plugin cache cleanup" cleanup_bunx_plugin_cache

  if ! run_timed "OpenCode plugin cache refresh" refresh_opencode_plugin_cache; then
    die "failed to refresh OpenCode plugin cache"
  fi

  log ""
  log "Running doctor..."
  local doctor_start
  local doctor_output
  local doctor_status=0
  local doctor_capture
  doctor_start="$(now_ms)"
  doctor_capture="$(mktemp)"
  set +e
  run_controller doctor 2>&1 | tee "$doctor_capture"
  doctor_status="${PIPESTATUS[0]}"
  set -e
  doctor_output="$(cat "$doctor_capture")"
  rm -f "$doctor_capture"
  log_timing "doctor" "$doctor_start"

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
  log "Start with: opencode --agent superpowers-agent"
  log_timing "install total" "$total_start"
}

main "$@"
