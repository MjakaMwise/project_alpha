#!/usr/bin/env bash
# Start Customize for development.
#   ./dev.sh -w        web: Rust server on http://localhost:4173
#   ./dev.sh -a        android: build, install and launch on an emulator or phone
#   ./dev.sh -w -a     both (also written -wa)
# Environment: PORT (web port, default 4173), ANDROID_SERIAL (pick a device), AVD (emulator name),
# NO_BROWSER=1 (do not open a browser tab), CUSTOMIZE_ADMIN_EMAIL + CUSTOMIZE_ADMIN_PASSWORD (create the
# first admin account if none exists), CUSTOMIZE_DATA (data folder, default ./data).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-4173}"
PACKAGE="com.casini.customize"
PREVIEW_PACKAGE="com.casini.customize.preview"

web=0; android=0
usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while getopts "wah" opt; do
  case "$opt" in
    w) web=1 ;;
    a) android=1 ;;
    h) usage 0 ;;
    *) usage 1 ;;
  esac
done
[ "$web$android" = "00" ] && usage 1

server_pid=""
cleanup() { [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2" >&2; exit 1; }; }

start_web() {
  need cargo "Install Rust from https://rustup.rs"
  if curl -fs "http://localhost:$PORT/" >/dev/null 2>&1; then
    echo "Port $PORT is already serving something. Stop it or run: PORT=4180 ./dev.sh -w" >&2; exit 1
  fi
  echo "Starting the Rust server on port $PORT..."
  (cd "$ROOT" && PORT="$PORT" cargo run --quiet) &
  server_pid=$!
  for _ in $(seq 1 120); do
    curl -fs "http://localhost:$PORT/" >/dev/null 2>&1 && break
    kill -0 "$server_pid" 2>/dev/null || { echo "The Rust server stopped. See the error above." >&2; exit 1; }
    sleep 1
  done
  # ?backend=server makes the page use this Rust backend instead of its built-in one.
  url="http://localhost:$PORT/?backend=server"
  echo "Web: $url"
  echo "Log in / sign up: http://localhost:$PORT/auth.html   Shop admin: http://localhost:$PORT/admin.html"
  if [ -z "${CUSTOMIZE_ADMIN_EMAIL:-}" ]; then
    echo "Tip: no admin env vars set. To create the first admin: CUSTOMIZE_ADMIN_EMAIL=you@example.com CUSTOMIZE_ADMIN_PASSWORD='a long password' ./dev.sh -w"
  fi
  [ "${NO_BROWSER:-0}" = "1" ] && return
  (xdg-open "$url" || open "$url") >/dev/null 2>&1 || true
}

find_adb() {
  if command -v adb >/dev/null 2>&1; then command -v adb; return; fi
  for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk"; do
    [ -n "$sdk" ] && [ -x "$sdk/platform-tools/adb" ] && { echo "$sdk/platform-tools/adb"; return; }
  done
  echo "Missing: adb. Install Android platform-tools or set ANDROID_HOME." >&2; exit 1
}

start_android() {
  ADB="$(find_adb)"
  SDK_DIR="$(dirname "$(dirname "$ADB")")"
  "$ADB" start-server >/dev/null
  if [ -z "$("$ADB" devices | awk 'NR>1 && $2=="device"')" ]; then
    EMU="$SDK_DIR/emulator/emulator"; [ -x "$EMU" ] || EMU="$(command -v emulator || true)"
    [ -n "$EMU" ] || { echo "No device is connected and no emulator was found. Plug in a phone or install an emulator." >&2; exit 1; }
    name="${AVD:-$("$EMU" -list-avds | head -n1)}"
    [ -n "$name" ] || { echo "No emulator images exist. Create one in Android Studio's Device Manager." >&2; exit 1; }
    echo "Starting emulator $name..."
    nohup "$EMU" -avd "$name" >/dev/null 2>&1 &
    "$ADB" wait-for-device
    until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
  fi
  echo "Building the Android app (this builds the Rust library too)..."
  (cd "$ROOT/android" && ./gradlew :app:assembleDebug)
  apk="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
  # Both app ids use the same loopback port, so stop the one we are not launching.
  "$ADB" shell am force-stop "$PREVIEW_PACKAGE" >/dev/null 2>&1 || true
  "$ADB" shell am force-stop "$PACKAGE" >/dev/null 2>&1 || true
  echo "Installing..."
  "$ADB" install -r "$apk"
  "$ADB" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null
  echo "Android: Customize is running on the device."
}

[ "$web" = 1 ] && start_web
[ "$android" = 1 ] && start_android

if [ -n "$server_pid" ]; then
  echo "Press Ctrl+C to stop the web server."
  wait "$server_pid"
fi
