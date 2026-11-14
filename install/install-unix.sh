#!/usr/bin/env sh
# Installs the Live Layer service for the current user on Linux (systemd --user) or macOS (launchd).
# Falls back to a background process when neither is available.
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
PORT=${LLP_PORT:-7710}
case "$(uname -s)" in
  Darwin) BASE="$HOME/Library/Application Support/LiveLayer" ;;
  *)      BASE="${XDG_DATA_HOME:-$HOME/.local/share}/livelayer" ;;
esac
APP="$BASE/app"; BIN="$HOME/.local/bin"
NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "Node.js isn't installed. Install Node 22+ and run again."; exit 1; }
MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 22 ] || { echo "Node $MAJOR found; the service needs Node 22 or newer."; exit 1; }

echo "-> copying files to $APP"
mkdir -p "$APP" "$BIN"
for d in host service build node_modules; do rm -rf "$APP/$d"; cp -R "$SRC/$d" "$APP/$d"; done
cp "$SRC/package.json" "$APP/"
printf '#!/bin/sh\nexec "%s" "%s/service/llp.mjs" "$@"\n' "$NODE" "$APP" > "$BIN/llp"; chmod +x "$BIN/llp"

if [ "$(uname -s)" = Darwin ]; then
  echo "-> registering launchd agent"
  PL="$HOME/Library/LaunchAgents/dev.livelayer.llpd.plist"
  mkdir -p "$(dirname "$PL")"
  cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.livelayer.llpd</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$APP/service/llpd.mjs</string><string>--port</string><string>$PORT</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$BASE/llpd.log</string><key>StandardErrorPath</key><string>$BASE/llpd.log</string>
</dict></plist>
EOF
  launchctl unload "$PL" 2>/dev/null || true
  launchctl load "$PL"
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  echo "-> registering systemd user service"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/llpd.service" <<EOF
[Unit]
Description=Live Layer service
[Service]
ExecStart=$NODE $APP/service/llpd.mjs --port $PORT
Restart=on-failure
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now llpd.service
else
  echo "-> no service manager found; starting in the background (won't survive a reboot)"
  pkill -f "$APP/service/llpd.mjs" 2>/dev/null || true
  nohup "$NODE" "$APP/service/llpd.mjs" --port "$PORT" >> "$BASE/llpd.log" 2>&1 &
fi

i=0; until "$NODE" -e "fetch('http://127.0.0.1:$PORT/status').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; do
  i=$((i+1)); [ $i -lt 40 ] || { echo "The service didn't start. See $BASE/llpd.log"; exit 1; }; sleep 0.25; done
echo "-> running on http://127.0.0.1:$PORT"
"$BIN/llp" push demo.tasks "main=$APP/build/tasks.wasm" "footer=$APP/build/stats.wasm"
echo "Done. Open http://127.0.0.1:$PORT/?app=demo.tasks   (make sure $BIN is on your PATH)"
