#!/bin/sh
# One-time setup for the agent-desktop plugin (macOS).
# Installs the CLI if missing and opens the permission panes for the Kimi Code app.
set -e

if ! command -v node >/dev/null 2>&1; then
  echo "node >= 18 is required (npm path). Install node first." >&2
  exit 1
fi

if ! command -v agent-desktop >/dev/null 2>&1; then
  echo "Installing agent-desktop CLI..."
  npm install -g agent-desktop
  # npm may block the postinstall script; the CLI binary ships in the package,
  # but approve the script if `agent-desktop version` fails.
  if ! command -v agent-desktop >/dev/null 2>&1; then
    echo "npm blocked install scripts. Run: npm approve-scripts agent-desktop" >&2
    exit 1
  fi
fi

agent-desktop version

PERMS="$(agent-desktop permissions)"
echo "$PERMS"

case "$PERMS" in
  *'"state":"denied"'*)
    echo "Opening System Settings - grant Accessibility and Screen Recording to the Kimi Code app."
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" || true
    sleep 1
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenRecording" || true
    ;;
  *)
    echo "Permissions look granted."
    ;;
esac

echo
echo "Next: install this folder as a Kimi Code Desktop plugin (local folder), then restart the session."
