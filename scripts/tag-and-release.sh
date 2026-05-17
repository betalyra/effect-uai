#!/usr/bin/env bash
#
# Creates a single repo-wide tag (e.g. `v0.5.1`) and a single combined
# GitHub Release for the current workspace version.
#
# Assumes every public package in `packages/**` is shipped at the same
# version (enforced via changesets' `fixed` group). The version is read
# from `packages/core/package.json` and cross-checked against every
# other public package; drift fails the run loudly.
#
# Release body concatenates each package's `## <version>` CHANGELOG
# section under a `## <package-name>` heading.
#
# Idempotent — no-op if the tag already exists on origin.
#
# Requires: jq, gh, git, awk, GH_TOKEN env var. Run from repo root.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve canonical version + tag.
# ---------------------------------------------------------------------------

version=$(jq -r .version packages/core/package.json)
tag="v${version}"
echo "Canonical version (from packages/core): ${version}"
echo "Tag: ${tag}"

# ---------------------------------------------------------------------------
# Drift check. Packages in changesets' `ignore` list are exempt (none
# currently — the bare `effect-uai` name-squat moved into the fixed
# group in 0.5.1).
# ---------------------------------------------------------------------------

mapfile -t IGNORED < <(jq -r '.ignore[]?' .changeset/config.json)
is_ignored() {
  local name="$1"
  for i in "${IGNORED[@]}"; do
    [[ "$i" == "$name" ]] && return 0
  done
  return 1
}

mismatched=()
while IFS= read -r pkg_json; do
  private=$(jq -r '.private // false' "$pkg_json")
  [[ "$private" == "true" ]] && continue
  name=$(jq -r .name "$pkg_json")
  is_ignored "$name" && continue
  v=$(jq -r .version "$pkg_json")
  if [[ "$v" != "$version" ]]; then
    mismatched+=("${name}@${v}")
  fi
done < <(find packages -name package.json -not -path '*/node_modules/*')

if (( ${#mismatched[@]} > 0 )); then
  echo "::error::Version drift detected. Expected ${version}, but found:" >&2
  printf '  - %s\n' "${mismatched[@]}" >&2
  echo "::error::Every public package must share the same version (enforced via .changeset/config.json#fixed)." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Bail out early if the tag is already on origin.
# ---------------------------------------------------------------------------

git fetch origin --tags --force
if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  echo "Tag ${tag} already exists on origin — nothing to do."
  exit 0
fi

# ---------------------------------------------------------------------------
# Build combined release notes: core first, then providers sorted by name.
# Per-package sections come from each package's own CHANGELOG.md.
# ---------------------------------------------------------------------------

notes_file="$(mktemp)"

packages=(packages/core packages/effect-uai)
while IFS= read -r dir; do
  packages+=("$dir")
done < <(find packages/providers -maxdepth 1 -mindepth 1 -type d | sort)

for dir in "${packages[@]}"; do
  pkg_json="${dir}/package.json"
  [[ -f "$pkg_json" ]] || continue
  private=$(jq -r '.private // false' "$pkg_json")
  [[ "$private" == "true" ]] && continue

  name=$(jq -r .name "$pkg_json")
  is_ignored "$name" && continue
  changelog="${dir}/CHANGELOG.md"

  section=$(awk -v ver="$version" '
    /^## / {
      if (in_section) exit
      if ($2 == ver) { in_section = 1; next }
    }
    in_section { print }
  ' "$changelog" 2>/dev/null || true)

  # Strip leading/trailing blank lines.
  section=$(printf '%s\n' "$section" | awk 'NF{p=1} p' | tac | awk 'NF{p=1} p' | tac)

  if [[ -n "$section" ]]; then
    {
      echo "## ${name}"
      echo
      echo "$section"
      echo
    } >> "$notes_file"
  fi
done

if [[ ! -s "$notes_file" ]]; then
  echo "Release v${version}." > "$notes_file"
fi

# ---------------------------------------------------------------------------
# Tag, push, create GitHub Release.
# ---------------------------------------------------------------------------

git tag -a "$tag" -m "Release $tag"
git push origin "refs/tags/${tag}"

gh release create "$tag" \
  --title "$tag" \
  --notes-file "$notes_file" \
  --verify-tag
