#!/bin/sh
# Build a release next to the running service, then switch to it. The service
# never compiles: a broken build or a full disk fails here, and the running
# release keeps serving.
#
#   scripts/deploy.sh [git ref]   # default origin/main
#
# Each release is an export of one commit in $NAKARA_RELEASES/<sha>, built
# with `npm ci` and `npm run build`. `current` is a symlink to the live one,
# switched atomically; the unit runs from it. Besides the new release and the
# one it replaces, the NAKARA_RELEASES_KEEP (3) newest older ones are kept
# for a rollback: `ln -sfn <release> current`, then restart. When the new
# release migrated the database, first run `npm run downgrade -- <version>`
# from it (Nakara stopped); see README, Rollback.
set -eu

src=${NAKARA_SRC:-$HOME/workspace/nakara}
releases=${NAKARA_RELEASES:-$HOME/.local/share/nakara/releases}
keep=${NAKARA_RELEASES_KEEP:-3}
restart=${NAKARA_RESTART:-1}
ref=${1:-origin/main}

# mise puts the pinned node on PATH, as in the unit.
run() {
  if command -v mise >/dev/null 2>&1; then mise exec -- "$@"; else "$@"; fi
}

git -C "$src" fetch --quiet origin
sha=$(git -C "$src" rev-parse --short=12 "$ref^{commit}")
dir=$releases/$sha
if [ ! -e "$dir/.built" ]; then
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$src" archive "$sha" | tar -x -C "$dir"
  # mise refuses config files in directories it has not been told to trust.
  if command -v mise >/dev/null 2>&1; then mise trust "$dir/mise.toml"; fi
  (cd "$dir" && run npm ci --no-audit --no-fund && run npm run build)
  touch "$dir/.built"
fi

previous=$(basename "$(readlink "$releases/current" || echo none)")
ln -sfn "$dir" "$releases/current.next"
mv -T "$releases/current.next" "$releases/current"
echo "current release: $sha"

# Prune older builds. The new release and the one still running until the
# restart always stay.
ls -1t "$releases" | grep -vx -e current -e "$sha" -e "$previous" |
  tail -n +"$((keep + 1))" |
  while read -r old; do rm -rf "${releases:?}/$old"; done

if [ "$restart" = 1 ]; then systemctl --user restart nakara; fi
