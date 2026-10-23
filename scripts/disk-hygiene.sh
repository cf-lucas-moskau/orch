#!/usr/bin/env bash
# Weekly disk hygiene for the Mac orch runs on. Dry run by default; --apply deletes.
# Never touches ~/Movies, ~/Downloads, Go's cache, or Docker volumes outside orch-*, pulse-* and pulsedev* compose projects.
set -uo pipefail

APPLY=0
case "${1:---dry-run}" in
  --apply) APPLY=1 ;;
  --dry-run) ;;
  *) echo "usage: $0 [--dry-run|--apply]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_TMP="${DISK_HYGIENE_TMP:-/private/tmp/claude-$(id -u)}"
CODE_DIR="${DISK_HYGIENE_CODE:-$HOME/code}"
BUILD_CACHE_KEEP_GB=5
NOW=$(date +%s)
WEEK=$((7 * 86400))

free_kb() { df -k "$ROOT" | awk 'NR==2 { print $4 }'; }
gb() { awk -v kb="$1" 'BEGIN { printf "%.1f GB", kb / 1048576 }'; }
# "1.23GB", "512MB", "0B" from docker into KB.
to_kb() {
  awk -v s="$1" 'BEGIN {
    n = s + 0; u = s; sub(/^[0-9.]+/, "", u)
    m["B"] = 1/1024; m["kB"] = 1; m["KB"] = 1; m["MB"] = 1024; m["GB"] = 1048576; m["TB"] = 1073741824
    printf "%d", n * (u in m ? m[u] : 0)
  }'
}
# Docker can hang when its VM is wedged; give up instead of blocking the weekly run.
with_timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }
run() { if [ "$APPLY" = 1 ]; then "$@"; fi; }
# du of paths in KB, 0 if none exist.
size_kb() { du -sk "$@" 2>/dev/null | awk '{ s += $1 } END { print s + 0 }'; }

SUMMARY=()
step() { SUMMARY+=("$(printf '%-22s %s' "$1" "$2")"); }
VERB=$([ "$APPLY" = 1 ] && echo freed || echo "would free")

BEFORE=$(free_kb)

# Every process's cwd and command line, so nothing in use gets deleted.
IN_USE="$( (lsof -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; ps -axww -o command= 2>/dev/null) )"
# A path counts as in use when a cwd or argument is it or lies under it, not when it merely shares a prefix.
# lsof reports resolved paths (/private/var for /var), so both spellings are checked.
in_use() {
  local p
  for p in "$1" "$(cd "$1" 2>/dev/null && pwd -P)"; do
    [ -n "$p" ] && grep -qE -- "(^|[[:space:]=:'\"])$(sed 's/[][\.*^$+?(){}|]/\\&/g' <<<"$p")(/|[[:space:]'\"]|$)" <<<"$IN_USE" && return 0
  done
  return 1
}

DOCKER=0
if command -v docker >/dev/null && with_timeout 15 docker info >/dev/null 2>&1; then DOCKER=1; fi

# 1. Build cache above 5 GB.
if [ "$DOCKER" = 1 ]; then
  cache_kb=$(to_kb "$(docker system df --format '{{.Type}} {{.Size}}' | awk '/^Build Cache/ { print $3 }')")
  over=$((cache_kb - BUILD_CACHE_KEEP_GB * 1048576)); [ "$over" -lt 0 ] && over=0
  if [ "$APPLY" = 1 ] && [ "$over" -gt 0 ]; then
    with_timeout 600 docker builder prune -f --max-used-space "${BUILD_CACHE_KEEP_GB}GB" >/dev/null 2>&1
    after=$(to_kb "$(docker system df --format '{{.Type}} {{.Size}}' | awk '/^Build Cache/ { print $3 }')")
    over=$((cache_kb - after))
  fi
  step "docker build cache" "$VERB $(gb "$over") (cache $(gb "$cache_kb"), keeps ${BUILD_CACHE_KEEP_GB} GB)"
else
  step "docker build cache" "skipped, Docker is not running"
fi

# 2. Images no container uses, created 7+ days ago (Docker records no last-used time).
if [ "$DOCKER" = 1 ]; then
  used=$(docker ps -aq | xargs docker inspect --format '{{.Image}}' 2>/dev/null)
  cutoff=$((NOW - WEEK))
  img_kb=0; img_n=0
  while read -r id created size; do
    [ -z "$id" ] && continue
    grep -q "$id" <<<"$used" && continue
    [ "$created" -gt "$cutoff" ] && continue
    img_kb=$((img_kb + size / 1024)); img_n=$((img_n + 1))
  done < <(docker image ls -aq --no-trunc | sort -u | xargs docker image inspect --format '{{.Id}} {{.Created}} {{.Size}}' 2>/dev/null |
    while read -r id created size; do echo "$id $(date -j -u -f '%Y-%m-%dT%H:%M:%S' "${created%%.*}" +%s 2>/dev/null || echo "$NOW") $size"; done)
  if [ "$APPLY" = 1 ] && [ "$img_n" -gt 0 ]; then
    out=$(with_timeout 600 docker image prune -a -f --filter "until=168h" 2>&1)
    img_kb=$(to_kb "$(sed -n 's/^Total reclaimed space: //p' <<<"$out")")
  fi
  step "docker images" "$VERB $(gb "$img_kb") ($img_n unused, 7+ days old; shared layers make this an upper bound)"
else
  step "docker images" "skipped, Docker is not running"
fi

# 3. Worker compose stacks (orch-*, pulse-*, pulsedev*) stopped for 7+ days, with their volumes.
if [ "$DOCKER" = 1 ]; then
  stale=()
  for p in $(docker compose ls -a --format json | jq -r '.[].Name | select(test("^(orch-|pulse-|pulsedev)"))'); do
    ids=$(docker ps -aq --filter "label=com.docker.compose.project=$p")
    [ -z "$ids" ] && continue
    # Running containers or any that stopped within the week keep the project.
    recent=$(docker inspect --format '{{.State.Running}} {{.State.FinishedAt}}' $ids | while read -r running finished; do
      t=$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "${finished%%.*}" +%s 2>/dev/null || echo "$NOW")
      if [ "$running" = true ] || [ $((NOW - t)) -lt "$WEEK" ]; then echo x; fi
    done)
    [ -z "$recent" ] && stale+=("$p")
  done
  vol_kb=0
  [ "${#stale[@]}" -gt 0 ] && volumes=$(docker system df -v | awk '/usage/ { on = /^Local Volumes/; next } on && NF && $1 != "VOLUME" { print $1, $NF }')
  for p in "${stale[@]+"${stale[@]}"}"; do
    for v in $(docker volume ls -q --filter "label=com.docker.compose.project=$p"); do
      vol_kb=$((vol_kb + $(to_kb "$(awk -v v="$v" '$1 == v { print $2 }' <<<"$volumes")")))
    done
    run with_timeout 300 docker compose -p "$p" down -v >/dev/null 2>&1
  done
  step "worker compose stacks" "$VERB $(gb "$vol_kb") of volumes (${#stale[@]} stopped 7+ days${stale[*]+: ${stale[*]}})"
else
  step "worker compose stacks" "skipped, Docker is not running"
fi

# 4. node_modules in ~/code projects untouched for 90+ days and not in use.
nm_kb=0; nm=()
for d in "$CODE_DIR"/*/; do
  d="${d%/}"
  [ -d "$d/node_modules" ] || continue
  fresh=$(find "$d" "$d"/package.json "$d"/package-lock.json "$d"/yarn.lock "$d"/pnpm-lock.yaml "$d"/bun.lockb -maxdepth 0 -mtime -90 2>/dev/null)
  [ -n "$fresh" ] && continue
  in_use "$d" && continue
  nm_kb=$((nm_kb + $(size_kb "$d/node_modules"))); nm+=("${d##*/}")
  run rm -rf "$d/node_modules"
done
step "stale node_modules" "$VERB $(gb "$nm_kb") (${#nm[@]} projects untouched 90+ days${nm[*]+: ${nm[*]}})"

# 5. Claude scratch folders idle 3+ days, except orch's own and running workers'.
keep=("$(sed 's/[^a-zA-Z0-9]/-/g' <<<"$ROOT")")
if [ -f "$ROOT/workers.json" ]; then
  while read -r wt; do keep+=("$(sed 's/[^a-zA-Z0-9]/-/g' <<<"$wt")"); done \
    < <(jq -r '.[] | select(.status == "running") | .worktree' "$ROOT/workers.json")
fi
tmp_kb=0; tmp_n=0
if [ -d "$CLAUDE_TMP" ]; then
  for d in "$CLAUDE_TMP"/*/; do
    d="${d%/}"; name="${d##*/}"
    printf '%s\n' "${keep[@]}" | grep -qxF -- "$name" && continue
    [ -n "$(find "$d" -mtime -3 -print -quit 2>/dev/null)" ] && continue
    in_use "$d" && continue
    tmp_kb=$((tmp_kb + $(size_kb "$d"))); tmp_n=$((tmp_n + 1))
    run rm -rf "$d"
  done
fi
step "claude scratch" "$VERB $(gb "$tmp_kb") ($tmp_n folders idle 3+ days)"

# 6. Electron updater leftovers; apps download them again when they update.
ship=("$HOME"/Library/Caches/*ShipIt)
ship_kb=0; ship_n=0
for d in "${ship[@]}"; do
  [ -d "$d" ] || continue
  in_use "$d" && continue
  ship_kb=$((ship_kb + $(size_kb "$d"))); ship_n=$((ship_n + 1))
  run rm -rf "$d"
done
step "ShipIt caches" "$VERB $(gb "$ship_kb") ($ship_n folders)"

AFTER=$(free_kb)
[ "$AFTER" -lt $((30 * 1048576)) ] && SUMMARY+=("WARNING: only $(gb "$AFTER") free after cleanup (under 30 GB); look at Docker.raw, worktrees and ~/code by hand")
echo "disk-hygiene ($([ "$APPLY" = 1 ] && echo apply || echo dry-run)): free $(gb "$BEFORE") before, $(gb "$AFTER") after"
printf '  %s\n' "${SUMMARY[@]}"
if [ "$APPLY" = 1 ]; then
  { echo "- $(date '+%Y-%m-%d %H:%M') disk-hygiene: free $(gb "$BEFORE") before, $(gb "$AFTER") after"; printf '  - %s\n' "${SUMMARY[@]}"; } >>"$ROOT/log.md"
fi
exit 0
