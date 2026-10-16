#!/usr/bin/env bash
# Builds the eidnara plugins, native addon, daemon, and host fixture in a clone
# of the configured checkout, so every artefact matches one commit and the
# checkout itself stays read-only. Usage: scripts/eidnara-build.sh <checkout> <clone>
set -euo pipefail
src=$1
dst=$2
src_real=$(realpath -m "$src")
dst_real=$(realpath -m "$dst")
case "$dst_real/" in
    "$src_real/"*)
        echo "eidnara-build: <clone> must be a separate directory outside <checkout> $src" >&2
        exit 64
        ;;
esac
case "$src_real/" in
    "$dst_real/"* | "$dst_real.partial/"*)
        echo "eidnara-build: <checkout> must be a separate directory outside <clone> $dst and its partial clone" >&2
        exit 64
        ;;
esac
dst=$dst_real
src=$src_real
# One build per clone at a time, held from the record's removal to its publication.
lock="$dst_real.lock"
if [ -L "$lock" ]; then
    echo "eidnara-build: $lock is a symlink" >&2
    exit 65
fi
exec 9>>"$lock"
if ! flock -n 9; then
    echo "eidnara-build: another build holds $dst_real.lock" >&2
    exit 75
fi
# .sim-build-source names the checkout this clone was made from, so the forced
# checkout and clean below only ever touch a clone this script created.
if [ -d "$dst/.git" ]; then
    if [ "$(cat "$dst/.sim-build-source" 2>/dev/null)" != "$src_real" ]; then
        echo "eidnara-build: $dst was not cloned by this script from $src" >&2
        exit 65
    fi
else
    # The clone is made beside the destination and renamed into place once it carries its
    # source record, so an interrupted clone leaves only the partial tree the next build removes.
    rm -rf "$dst.partial"
    git clone --quiet --no-hardlinks "$src" "$dst.partial"
    printf '%s\n' "$src_real" > "$dst.partial/.sim-build-source"
    mv -T "$dst.partial" "$dst"
fi
# .sim-build-commit exists only between a completed build and the next start,
# so a clone without it holds a mixed or partial tree.
rm -f "$dst/.sim-build-commit"
git -C "$dst" fetch --quiet "$src" HEAD
# The clone is the harness's own build tree: edits and stray files from an earlier build go,
# while ignored outputs (node_modules, target, dist) stay for the incremental build.
git -C "$dst" checkout --quiet --force --detach FETCH_HEAD
git -C "$dst" clean --quiet --force -d --exclude=.sim-build-source
cd "$dst"
bun install --frozen-lockfile
(cd packages/shm-native && bun run build)
(cd packages/pi-plugin && bun run build)
(cd packages/opencode-plugin && bun run build)
cargo build --locked --release -p daemon --example direct_host_fixture --bin eidnara-host \
    --features direct-host-fixture
git -C "$dst" rev-parse HEAD | tee "$dst/.sim-build-commit"
