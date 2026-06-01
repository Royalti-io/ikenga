#!/usr/bin/env bash
# Changesets "publish" step for the shell.
#
# The shell is a private Tauri app — it is NOT published to npm. Instead, once
# the "Version Packages" PR merges (package.json + the synced tauri/cargo files
# are bumped, no changesets remain), this script pushes a `v<version>` git tag.
# That tag triggers the existing release.yml, which builds the .deb/assets and
# creates the GitHub Release. Keeps Changesets as the single source of the
# version while leaving the heavy asset build on the tag-push path.
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "tag-release: $TAG already exists — nothing to do"
  exit 0
fi

git tag -a "$TAG" -m "Ikenga $TAG"
git push origin "$TAG"
echo "tag-release: pushed $TAG → release.yml will build assets"
