#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPECTED_DIR="$HOME/.pi/agent"

# Verify we're in the right place
if [ "$SCRIPT_DIR" != "$EXPECTED_DIR" ]; then
  echo "⚠️  This repo should be cloned to ~/.pi/agent/"
  echo "   Current location: $SCRIPT_DIR"
  echo "   Expected: $EXPECTED_DIR"
  echo ""
  echo "   Run: git clone git@github.com:HazAT/pi-config $EXPECTED_DIR"
  exit 1
fi

echo "Setting up pi-config at $EXPECTED_DIR"
echo ""

# Create settings.json if it doesn't exist
if [ ! -f "$EXPECTED_DIR/settings.json" ]; then
  echo "Creating settings.json..."
  cat > "$EXPECTED_DIR/settings.json" << 'EOF'
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-6.1-sol",
  "defaultThinkingLevel": "medium",
  "packages": [
    "git:github.com/pasky/chrome-cdp-skill",
    "git:github.com/HazAT/glimpse",
    "git:github.com/IgorMitev/pi-interactive-subagents@32dbad521c0209577c6eb21614643ea65723f132",
    {
      "source": "git:github.com/HazAT/pi-autoresearch",
      "extensions": [
        "-extensions/pi-autoresearch/index.ts"
      ],
      "skills": []
    },
    "git:https://github.com/badlogic/pi-diff-review"
  ],
  "hideThinkingBlock": true,
  "extensions": [
    "+extensions/cmux/index.ts"
  ],
  "theme": "everforest"
}
EOF
else
  echo "settings.json already exists — skipping creation"
  echo ""
fi

# Reconcile declared packages (including missing installs) without rewriting filters.
# Ignore project-local packages and explicitly target this config directory.
echo "Installing/updating configured packages..."
PI_CODING_AGENT_DIR="$EXPECTED_DIR" pi update --extensions --no-approve
echo ""

echo "✅ Setup complete!"
echo ""
echo "Restart pi to pick up all changes."
