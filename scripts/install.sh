#!/usr/bin/env bash
# install.sh — provisionne la config Pi depuis ce repo vers ~/.pi/agent/.
#
# Idempotent : re-exécutable sans danger.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PI_HOME="${HOME}/.pi/agent"

echo "==> Repo : $REPO_DIR"
echo "==> Cible : $PI_HOME"

mkdir -p "$PI_HOME/extensions" "$PI_HOME/agents"

# 1. npm deps de fetch-clean
echo "==> npm install (fetch-clean)"
cd "$REPO_DIR/extensions/fetch-clean"
npm install --silent

# 2. Packages tiers (pi-subagents)
echo "==> npm install (_packages)"
cd "$REPO_DIR/extensions/_packages"
npm install --silent

# 3. Symlinks extensions
echo "==> symlink fetch-clean"
ln -sfn "$REPO_DIR/extensions/fetch-clean" "$PI_HOME/extensions/fetch-clean"

echo "==> symlink rtk-bash"
ln -sfn "$REPO_DIR/extensions/rtk-bash" "$PI_HOME/extensions/rtk-bash"

echo "==> symlink pi-subagents (vers le sous-répertoire src/ du package npm)"
ln -sfn "$REPO_DIR/extensions/_packages/node_modules/@tintinweb/pi-subagents/src" "$PI_HOME/extensions/pi-subagents"

# 4. Symlinks agents
echo "==> symlink agents"
for f in "$REPO_DIR"/agents/*.md; do
  name="$(basename "$f")"
  ln -sfn "$f" "$PI_HOME/agents/$name"
done

echo ""
echo "✓ Installation terminée."
echo ""
echo "Vérification :"
ls -la "$PI_HOME/extensions/" "$PI_HOME/agents/"
echo ""
echo "Test rapide :"
echo "  pi -p --provider sglang-homelab --model Qwen/Qwen3.6-35B-A3B-FP8 'liste tes outils'"
