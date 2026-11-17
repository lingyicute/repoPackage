#!/usr/bin/env bash
#
# Sync every public, non-fork repository of $OWNER into the current git
# repository as a plain sub-directory (shallow clone, .git removed).
#
#  * The repository list is fetched from the GitHub API, so new repositories
#    are picked up automatically and renamed/deleted/forked ones are pruned.
#  * Existing directories are only replaced after a successful clone, so a
#    transient network error never wipes a mirrored copy.
#  * Clones run in parallel and are retried.
#
# Env (all optional):
#   OWNER       GitHub user to mirror            (default: lingyicute)
#   SELF_REPO   this repository, never cloned    (default: repoPackage)
#   JOBS        parallel clones                  (default: 8)
#   MIN_REPOS   sanity floor for the API result  (default: 20)
#   GITHUB_TOKEN  used for API calls only (higher rate limit)
set -euo pipefail

OWNER="${OWNER:-lingyicute}"
SELF_REPO="${SELF_REPO:-repoPackage}"
JOBS="${JOBS:-8}"
MIN_REPOS="${MIN_REPOS:-20}"

# Repositories that must never be mirrored (exact name, case-insensitive).
EXCLUDE_EXACT=(
  MusicDatabase
  StarryStoreStatics
  Iridium
  YiTap
  StarryCloud-source
  StarryCloud-statics
  Yomi-Web
  StarryFilesNT
)
# Glob patterns that must never be mirrored (case-insensitive).
EXCLUDE_GLOB=(
  'TODO*'
)

is_excluded() {
  local name="$1" lc="${1,,}" x
  [[ "$name" == .* ]] && return 0                 # e.g. ".github" would clash with the workflow dir
  [[ "$lc" == "${SELF_REPO,,}" ]] && return 0     # avoid recursively cloning ourselves
  for x in "${EXCLUDE_EXACT[@]}"; do
    [[ "$lc" == "${x,,}" ]] && return 0
  done
  for x in "${EXCLUDE_GLOB[@]}"; do
    # shellcheck disable=SC2053
    [[ "$lc" == ${x,,} ]] && return 0
  done
  return 1
}

list_repos() {
  local page=1 resp count
  local auth=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  while :; do
    resp="$(curl -fsSL --retry 3 --retry-delay 5 "${auth[@]}" \
      -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/users/${OWNER}/repos?type=owner&per_page=100&page=${page}")"
    count="$(jq 'length' <<<"$resp")"
    jq -r '.[] | select(.fork == false and .private == false) | .name' <<<"$resp"
    if (( count < 100 )); then break; fi
    page=$((page + 1))
  done
}

cd "$(git rev-parse --show-toplevel)"

echo "::group::Resolve repository list"
mapfile -t ALL < <(list_repos | sort -u)
WANTED=()
for name in "${ALL[@]}"; do
  if is_excluded "$name"; then
    echo "skip  $name"
  else
    WANTED+=("$name")
  fi
done
echo "Found ${#ALL[@]} public non-fork repos, mirroring ${#WANTED[@]}."
echo "::endgroup::"

if (( ${#WANTED[@]} < MIN_REPOS )); then
  echo "::error::Only ${#WANTED[@]} repositories resolved (< ${MIN_REPOS}); refusing to continue."
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/repos" "$WORK/status"

clone_one() {
  local name="$1" i
  for i in 1 2 3; do
    rm -rf "${WORK:?}/repos/${name}"
    if GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1 \
       git clone --depth=1 --no-tags --quiet \
         "https://github.com/${OWNER}/${name}.git" "${WORK}/repos/${name}" \
         2>"${WORK}/status/${name}.log"; then
      rm -rf "${WORK:?}/repos/${name}/.git"
      touch "${WORK}/status/${name}.ok"
      echo "ok    ${name}"
      return 0
    fi
    sleep $((i * 5))
  done
  echo "FAIL  ${name}"
  return 1
}
export -f clone_one
export WORK OWNER

echo "::group::Clone repositories"
printf '%s\n' "${WANTED[@]}" \
  | xargs -P "$JOBS" -I{} bash -c 'clone_one "$1" || true' _ {}
echo "::endgroup::"

# Replace directories only for repos that were cloned successfully.
FAILED=()
for name in "${WANTED[@]}"; do
  if [[ -f "$WORK/status/$name.ok" ]]; then
    rm -rf "./${name}"
    mv "$WORK/repos/$name" "./${name}"
  else
    FAILED+=("$name")
    echo "::warning::Failed to clone ${name}; keeping previous copy."
    sed 's/^/    /' "$WORK/status/$name.log" 2>/dev/null || true
  fi
done

# Prune directories of repos that no longer qualify (deleted, renamed, now a
# fork/private, or newly excluded). Top-level files and dot-dirs are kept.
declare -A KEEP=()
for name in "${WANTED[@]}"; do KEEP["$name"]=1; done
for dir in */; do
  dir="${dir%/}"
  [[ "$dir" == "$SELF_REPO" ]] && continue
  if [[ -z "${KEEP[$dir]:-}" ]]; then
    echo "prune $dir"
    rm -rf "./${dir}"
  fi
done

if (( ${#FAILED[@]} > 0 )); then
  echo "::error::${#FAILED[@]} repo(s) failed to sync: ${FAILED[*]}"
  exit 1
fi
echo "All ${#WANTED[@]} repositories synced."
