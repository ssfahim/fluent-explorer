#!/bin/bash
echo "Uninstalling Fluent Explorer + Photos..."
rm -rf "$HOME/.local/share/win-explorer"
rm -rf "$HOME/.cache/winex-thumbs"
rm -f "$HOME/.local/share/applications/win-explorer.desktop"
rm -f "$HOME/.local/share/applications/win-photos.desktop"
rm -f "$HOME/.config/winex-"*.json
rm -f "$HOME/.config/fluent-explorer-memory.json"
rm -f "$HOME/.cache/winex-debug.log" "$HOME/.cache/winex-performance.log"
update-desktop-database "$HOME/.local/share/applications/" 2>/dev/null || true
echo "✓ Removed."
