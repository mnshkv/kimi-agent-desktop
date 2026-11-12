#!/bin/sh
# One-time setup for the agent-desktop plugin (macOS).
# Installs the CLI (>= 1.2.0 for `agent-desktop mcp`) and opens the permission panes.
set -e

if ! command -v agent-desktop >/dev/null 2>&1; then
  echo "Installing agent-desktop CLI..."
  if command -v brew >/dev/null 2>&1; then
    brew install agent-desktop
  else
    npm install -g agent-desktop
    # npm may block the postinstall script; the CLI binary ships in the package,
    # but approve the script if `agent-desktop version` fails.
    if ! command -v agent-desktop >/dev/null 2>&1; then
      echo "npm blocked install scripts. Run: npm approve-scripts agent-desktop" >&2
      exit 1
    fi
  fi
fi

V="$(agent-desktop version)"
echo "agent-desktop $V"

case "$V" in
  [0-9].*|1.0.*|1.1.*) echo "ERROR: agent-desktop >= 1.2.0 is required for the built-in MCP server (agent-desktop mcp)." >&2; exit 1 ;;
esac

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
