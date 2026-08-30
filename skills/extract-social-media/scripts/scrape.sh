#!/usr/bin/env bash
# Renders a URL to HTML on stdout.
#
# Prefers Lightpanda: most marketing sites build their footer — where the social
# icons live — in JavaScript, so a plain curl often returns a shell with no links
# in it. Falls back to curl when Lightpanda is neither installed nor downloadable,
# which still works for server-rendered sites.
set -euo pipefail

URL="${1:?usage: scrape.sh <url> [wait-ms]}"
WAIT_MS="${2:-5000}"
CACHE="${LIGHTPANDA_CACHE:-${TMPDIR:-/tmp}/lightpanda}"

find_lightpanda() {
  if [ -n "${LIGHTPANDA_BIN:-}" ] && [ -x "$LIGHTPANDA_BIN" ]; then echo "$LIGHTPANDA_BIN"; return 0; fi
  if command -v lightpanda >/dev/null 2>&1; then command -v lightpanda; return 0; fi
  if [ -x "$CACHE/lightpanda" ]; then echo "$CACHE/lightpanda"; return 0; fi

  # Single static binary, no runtime deps — cheap to fetch once per sandbox.
  case "$(uname -m)" in
    x86_64|amd64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) return 1 ;;
  esac
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    *) return 1 ;;
  esac

  mkdir -p "$CACHE"
  url="https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-${arch}-${os}"
  curl -fsSL --max-time 120 -o "$CACHE/lightpanda" "$url" || return 1
  chmod +x "$CACHE/lightpanda"
  echo "$CACHE/lightpanda"
}

fetch_with_curl() {
  curl -fsSL --max-time 60 -A 'Mozilla/5.0 (compatible; social-extractor/1.0)' "$URL"
}

# Lightpanda being *findable* is not the same as it *working*. Under a hardened
# service unit — private /tmp, seccomp, no /dev/shm, a memory cap — a headless
# browser that runs fine in an interactive shell exits non-zero or is killed,
# and with `set -e` that took the whole script down. The caller then reported
# "site scrape failed" with no cause, and presence fell back to search on a
# machine where the plain curl path would have worked perfectly.
#
# So a lightpanda failure is a fallback, not an error. Curl is worse — it misses
# links a page builds in JavaScript — but worse is not nothing.
html=""
if bin="$(find_lightpanda 2>/dev/null)"; then
  # --strip-mode full drops script/style/media, leaving markup with the links in it.
  # Lightpanda logs page JS exceptions to stderr; they are noise, not failures.
  # `if ! cmd` swallows the real status — inside `else`, $? is the command's own.
  if html="$("$bin" fetch --dump html --strip-mode full --wait-until networkidle --wait-ms "$WAIT_MS" "$URL" 2>/dev/null)"; then
    :
  else
    echo "lightpanda failed (exit $?), falling back to curl" >&2
    html=""
  fi
fi

if [ -z "$html" ]; then
  [ -n "${bin:-}" ] || echo "lightpanda unavailable, falling back to curl (JS-rendered links will be missed)" >&2
  html="$(fetch_with_curl)"
fi

printf '%s' "$html"
