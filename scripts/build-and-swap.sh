#!/bin/bash
#
# Build J-Motion beside the live build, then swap it in and restart PM2.
#
#   scripts/build-and-swap.sh
#
# WHY. PM2 runs `next start` in this folder, and it serves `.next`. A plain `npm run build`
# rewrites `.next` underneath the running server: from the first byte written until the restart,
# pages ask for chunk files that are gone (they come back 400), and a build that fails half-way
# leaves the live folder half-written. So the build goes to `.next-build` instead (next.config.mjs
# reads NEXT_DIST_DIR), and the live folder is only touched once that build has succeeded.
#
# WHAT HAPPENS
#   1. Build into .next-build.        Fails → exit 1. .next and the running app are untouched.
#   2. .next → .next-prev, .next-build → .next, pm2 restart j-motion — back to back.
#   3. Check the restart took: PM2 says online with a start time after the swap, AND the app
#      answers /jmotion/login with 200 AND the webpack chunk that page names also comes back 200
#      (proof it is serving the NEW build — the old process would name a chunk that's gone).
#   4. Check fails → swap .next-prev back, restart again, exit 1. Loudly, either way.
#
# .next-prev is kept until the next run, so a manual rollback is the same two moves plus a restart:
#   mv .next .next-bad && mv .next-prev .next && pm2 restart j-motion
#
# `npm run build` on its own still builds into `.next` and still disturbs the live app. Use this.
#
# ── LATER: standalone output (not built — notes for when we want it) ──────────────────────────
# Removes the remaining gap (the restart) and makes rollback a link flip:
#   - next.config.mjs: `output: 'standalone'`. The build then emits .next/standalone/server.js,
#     a self-contained server with only the node_modules it needs.
#   - Build in a separate checkout of the commit (git worktree), not in this folder.
#   - Copy .next/standalone + .next/static (→ standalone/.next/static) + public/ (→ standalone/public)
#     into releases/<sha>/. Standalone does NOT copy static or public itself.
#   - Runtime env: standalone doesn't read .env from this folder; put the server-side vars
#     (SUPABASE_SERVICE_ROLE_KEY etc.) in ecosystem.config.js env, or an env_file. NEXT_PUBLIC_* are
#     baked in at build time, so the build checkout needs .env too.
#   - ecosystem.config.js: script `releases/current/server.js`, cwd `releases/current`,
#     env PORT=3001 and HOSTNAME=:: (standalone binds 0.0.0.0 by default — IPv6 matters here,
#     AnythingLLM holds 127.0.0.1:3001).
#   - Switch = `ln -sfn releases/<sha> releases/current && pm2 reload j-motion`; two PM2 instances
#     in cluster mode would make that reload zero-downtime.
#   - Check: basePath /jmotion and middleware behave the same under server.js; prune old releases.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PM2_NAME="j-motion"
PORT="${PORT:-3001}"
BASE_URL="http://[::1]:${PORT}/jmotion"   # IPv6: AnythingLLM holds 127.0.0.1:3001
HEALTH_TIMEOUT=60                          # seconds to wait for the restarted app

cd "$APP_DIR"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m!!! DEPLOY FAILED: %s\033[0m\n\n' "$*" >&2; exit 1; }

# One deploy at a time: two interleaved swaps would leave either folder anywhere.
LOCK="$APP_DIR/.deploy.lock"
mkdir "$LOCK" 2>/dev/null || fail "another build-and-swap is running (or a stale $LOCK — remove it if not)"
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

command -v pm2 >/dev/null || fail "pm2 not found on PATH"
pm2 describe "$PM2_NAME" >/dev/null 2>&1 || fail "no PM2 process named $PM2_NAME"

# ── 1. Build beside the live folder ─────────────────────────────────────────────────────────
say "Building into .next-build (the live .next is not touched)"
rm -rf .next-build
if ! NEXT_DIST_DIR=.next-build npx next build; then
  rm -rf .next-build
  fail "build failed — nothing swapped, nothing restarted; the live app is as it was"
fi
[ -f .next-build/BUILD_ID ] || fail "build reported success but .next-build/BUILD_ID is missing — nothing swapped"
NEW_BUILD_ID="$(cat .next-build/BUILD_ID)"

# Cleared now, while nothing is waiting on it, so the swap below is two renames and no deletes.
rm -rf .next-prev

# ── health check ──────────────────────────────────────────────────────────────────────────────
# Succeeds only if PM2 has (re)started the process since $1 (epoch ms) and is online, and the app
# serves the login page AND the webpack chunk it names. Retries until HEALTH_TIMEOUT.
healthy_since() {
  local since_ms="$1" deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    local pm2_state
    pm2_state="$(pm2 jlist 2>/dev/null | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        try {
          const json = s.slice(s.indexOf("["))
          const p = JSON.parse(json).find(x => x.name === process.argv[1])
          if (!p) return console.log("missing")
          console.log(p.pm2_env.status === "online" && p.pm2_env.pm_uptime >= Number(process.argv[2]) ? "ok" : "waiting")
        } catch { console.log("unreadable") }
      })' "$PM2_NAME" "$since_ms")"
    if [ "$pm2_state" = "ok" ]; then
      local html chunk code
      html="$(curl -s --max-time 5 "$BASE_URL/login" || true)"
      chunk="$(printf '%s' "$html" | grep -o '/jmotion/_next/static/chunks/webpack-[^"]*\.js' | head -1 || true)"
      if [ -n "$chunk" ]; then
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://[::1]:${PORT}${chunk}" || true)"
        [ "$code" = "200" ] && return 0
      fi
    fi
    sleep 0.5
  done
  return 1
}

now_ms() { node -e 'console.log(Date.now())'; }

# ── 2. Swap and restart, back to back ─────────────────────────────────────────────────────────
say "Swapping .next-build in (build $NEW_BUILD_ID) and restarting $PM2_NAME"
SWAP_MS="$(now_ms)"
[ -d .next ] && mv .next .next-prev
mv .next-build .next
pm2 restart "$PM2_NAME" >/dev/null || RESTART_FAILED=1

# ── 3. Did it take? ───────────────────────────────────────────────────────────────────────────
if [ -z "${RESTART_FAILED:-}" ] && healthy_since "$SWAP_MS"; then
  say "Deployed build $NEW_BUILD_ID — PM2 online, $BASE_URL/login and its chunks answering. Previous build kept in .next-prev."
  exit 0
fi

# ── 4. Roll back ──────────────────────────────────────────────────────────────────────────────
printf '\n\033[1;31m!!! New build did not come up healthy within %ss — rolling back\033[0m\n' "$HEALTH_TIMEOUT" >&2
pm2 describe "$PM2_NAME" 2>&1 | grep -E 'status|restarts|uptime' >&2 || true
[ -d .next-prev ] || fail "no .next-prev to roll back to — the app is on the new build and NOT healthy. Check: pm2 logs $PM2_NAME"
rm -rf .next-failed
mv .next .next-failed
mv .next-prev .next
ROLLBACK_MS="$(now_ms)"
pm2 restart "$PM2_NAME" >/dev/null || true
if healthy_since "$ROLLBACK_MS"; then
  fail "new build was unhealthy; ROLLED BACK to the previous build, which is answering. Failed build kept in .next-failed. Check: pm2 logs $PM2_NAME"
fi
fail "new build was unhealthy AND the rollback did not come up healthy either. The app may be DOWN. Check: pm2 logs $PM2_NAME"
