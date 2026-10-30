#!/usr/bin/env bash
# Run explicitly on the VPS after installing Docker. No account data is required.
set -euo pipefail
if [[ "$(id -u)" != 0 || "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'Run this installer as root on a Linux x86_64 VPS.' >&2
  exit 1
fi
command -v python3 >/dev/null
command -v docker >/dev/null
docker info >/dev/null
source_dir="$(cd "$(dirname "$0")/../.." && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
cp "$source_dir/operator/vps/Dockerfile" "$source_dir/operator/vps/Dockerfile.base" "$source_dir/operator/vps/prepare_driver.py" "$build_dir/"
cd "$build_dir"
python3 prepare_driver.py
if ! docker image inspect weespy-radar-firefox:local >/dev/null 2>&1; then
  docker build -f Dockerfile.base -t weespy-radar-firefox:local .
fi
docker build --pull=false -t weespy-connect-firefox:v1 .
install -d -m 755 /opt/weespy-connect-vps
cd "$source_dir"
tar --exclude='__pycache__' --exclude='*.pyc' -cf - connect.mjs package.json operator | tar -xf - -C /opt/weespy-connect-vps
chown -R root:root /opt/weespy-connect-vps
chmod -R go-w /opt/weespy-connect-vps
install -d -m 700 /etc/weespy/account-sessions
echo 'VPS engine installed. Configure this server in the Mac dashboard.'
