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

# Push the tag. CRITICAL: a tag pushed with the default Actions GITHUB_TOKEN
# does NOT trigger other workflows (GitHub's anti-recursion rule), so
# release.yml (`on: push: tags v*`) would never fire and no assets would build.
# When RELEASE_PAT is set (a PAT/fine-grained token with contents:write, wired
# in version.yml's env from the RELEASE_PAT secret), push over an explicit
# token URL so the push is attributed to that token and DOES trigger release.yml.
# Falls back to a plain `git push origin` when RELEASE_PAT is absent — that's
# fine for a local human-creds push (which also triggers workflows), and in CI
# without the secret it degrades to the old "tag pushed but build must be
# kicked manually" behaviour (see royalti-io/ikenga#26).
if [ -n "${RELEASE_PAT:-}" ]; then
  repo="${GITHUB_REPOSITORY:-royalti-io/ikenga}"
  # Try the PAT push (triggers release.yml). If the token lacks contents:write
  # or is expired, DON'T hard-fail the publish step — fall back to a plain push
  # so the tag still lands (build can be kicked manually). This keeps reusing a
  # general-purpose token (e.g. WORKSPACE_DEPS_PAT) safe even if its scope is
  # narrower than expected.
  if git push "https://x-access-token:${RELEASE_PAT}@github.com/${repo}.git" "$TAG"; then
    echo "tag-release: pushed $TAG via RELEASE_PAT → release.yml will build assets"
  else
    echo "tag-release: WARN — RELEASE_PAT push failed (token scope/expiry?) — falling back to plain push"
    git push origin "$TAG"
    echo "tag-release: pushed $TAG via default remote — release.yml may need a manual kick (#26)"
  fi
else
  git push origin "$TAG"
  echo "tag-release: pushed $TAG via default remote → release.yml build assets"
  echo "tag-release: NOTE — if pushed by GITHUB_TOKEN in CI, release.yml will NOT"
  echo "tag-release:        auto-trigger (see #26). Set the RELEASE_PAT secret, or"
  echo "tag-release:        re-push the tag with a human/PAT token to fire the build."
fi
