#!/usr/bin/env bash
# Builds the eidnara plugins, native addon, daemon, and host fixture in a clone
# of the configured checkout, so every artefact matches one commit and the
# checkout itself stays read-only. Usage: scripts/eidnara-build.sh <checkout> <clone>
set -euo pipefail
src=$1
dst=$2
if [ ! -d "$dst/.git" ]; then
    git clone --quiet --no-hardlinks "$src" "$dst"
fi
git -C "$dst" fetch --quiet "$src" HEAD
# The clone is the harness's own build tree: edits and stray files from an earlier build go,
# while ignored outputs (node_modules, target, dist) stay for the incremental build.
git -C "$dst" checkout --quiet --force --detach FETCH_HEAD
git -C "$dst" clean --quiet --force -d
cd "$dst"
bun install --frozen-lockfile
(cd packages/shm-native && bun run build)
(cd packages/pi-plugin && bun run build)
(cd packages/opencode-plugin && bun run build)
cargo build --locked --release -p daemon --example direct_host_fixture --bin eidnara-host \
    --features direct-host-fixture
git -C "$dst" rev-parse HEAD
