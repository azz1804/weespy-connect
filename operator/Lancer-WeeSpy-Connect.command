#!/bin/zsh
set -e
cd "${0:A:h}/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null || [[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 26')" != "true" ]]; then
  print 'Installe Node.js 26 pour lancer WeeSpy Connect.'
  read -r '?Appuie sur Entrée pour fermer. '
  exit 1
fi
if [[ ! -d node_modules/impit ]]; then
  npm ci --ignore-scripts --no-audit --no-fund
fi
node operator/server.mjs
