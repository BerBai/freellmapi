#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
upstream_remote="${UPSTREAM_REMOTE:-upstream}"
origin_remote="${ORIGIN_REMOTE:-origin}"
upstream_branch="${UPSTREAM_BRANCH:-main}"
work_branch="${WORK_BRANCH:-feat/self-hosted-catalog}"
push_changes=false

usage() {
  cat <<'USAGE'
Usage:
  scripts/fork/upstream-sync.sh status [--no-fetch]
  scripts/fork/upstream-sync.sh list [COUNT]
  scripts/fork/upstream-sync.sh update-main [--push]
  scripts/fork/upstream-sync.sh rebase [--push]
  scripts/fork/upstream-sync.sh cherry-pick <commit> [<commit> ...] [--push]
  scripts/fork/upstream-sync.sh sync [--push]

Commands:
  status       Show local, fork, and upstream branch positions.
  list         List upstream commits not present on the work branch.
  update-main Fast-forward local main from upstream/main.
  rebase       Rebase the work branch onto upstream/main.
  cherry-pick  Apply selected upstream commits to the work branch.
  sync         Update main, then rebase the work branch onto upstream/main.

Environment overrides:
  UPSTREAM_REMOTE  Upstream remote name       (default: upstream)
  ORIGIN_REMOTE    Fork remote name           (default: origin)
  UPSTREAM_BRANCH  Upstream branch            (default: main)
  WORK_BRANCH      Fork work branch           (default: feat/self-hosted-catalog)

--push pushes the updated branch to the fork remote. Rebases use
--force-with-lease. The upstream remote is never pushed to.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '==> %s\n' "$*"
}

require_git_repo() {
  git -C "$project_root" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "not a Git repository: $project_root"
}

require_remote() {
  local remote="$1"
  git -C "$project_root" remote get-url "$remote" >/dev/null 2>&1 \
    || die "Git remote not found: $remote"
}

require_branch() {
  local branch="$1"
  git -C "$project_root" show-ref --verify --quiet "refs/heads/$branch" \
    || die "local branch not found: $branch"
}

require_clean_worktree() {
  local status
  status="$(git -C "$project_root" status --porcelain)"
  [[ -z "$status" ]] || die "working tree is not clean; commit or stash changes first"
}

fetch_upstream() {
  info "fetching $upstream_remote/$upstream_branch"
  git -C "$project_root" fetch "$upstream_remote" "$upstream_branch" --prune
}

current_branch() {
  git -C "$project_root" branch --show-current
}

switch_branch() {
  local branch="$1"
  require_branch "$branch"
  info "switching to $branch"
  git -C "$project_root" switch "$branch"
}

pull_main_ff() {
  local upstream_ref="$upstream_remote/$upstream_branch"
  switch_branch "$upstream_branch"
  info "fast-forwarding $upstream_branch to $upstream_ref"
  git -C "$project_root" merge --ff-only "$upstream_ref"

  if [[ "$push_changes" == true ]]; then
    info "pushing $upstream_branch to $origin_remote"
    git -C "$project_root" push "$origin_remote" "$upstream_branch"
  fi
}

rebase_work_branch() {
  local upstream_ref="$upstream_remote/$upstream_branch"
  [[ "$work_branch" != "$upstream_branch" ]] || die "WORK_BRANCH must differ from UPSTREAM_BRANCH"
  switch_branch "$work_branch"
  info "rebasing $work_branch onto $upstream_ref"
  git -C "$project_root" rebase "$upstream_ref"

  if [[ "$push_changes" == true ]]; then
    info "pushing rebased $work_branch with --force-with-lease"
    git -C "$project_root" push --force-with-lease "$origin_remote" "$work_branch"
  fi
}

show_status() {
  local upstream_ref="$upstream_remote/$upstream_branch"
  local branch
  branch="$(current_branch)"
  [[ -n "$branch" ]] || branch="(detached HEAD)"

  printf 'repository: %s\n' "$project_root"
  printf 'branch:     %s\n' "$branch"
  printf 'upstream:   %s\n' "$upstream_ref"
  printf 'work:       %s\n\n' "$work_branch"

  git -C "$project_root" log -1 --oneline --decorate
  printf '\n'

  for ref in "$upstream_branch" "$work_branch"; do
    require_branch "$ref"
    local counts upstream_only local_only
    counts="$(git -C "$project_root" rev-list --left-right --count "$upstream_ref...$ref")"
    read -r upstream_only local_only <<<"$counts"
    printf '%-28s ahead: %s, behind: %s\n' "$ref" "$local_only" "$upstream_only"
  done
}

list_upstream_commits() {
  local count="${1:-40}"
  [[ "$count" =~ ^[0-9]+$ ]] || die "COUNT must be a positive integer"
  git -C "$project_root" log --oneline --decorate --max-count="$count" \
    "$work_branch..$upstream_remote/$upstream_branch"
}

parsed_args=()
for arg in "$@"; do
  case "$arg" in
    --push) push_changes=true ;;
    *) parsed_args[${#parsed_args[@]}]="$arg" ;;
  esac
done
if [[ ${#parsed_args[@]} -gt 0 ]]; then
  set -- "${parsed_args[@]}"
else
  set --
fi

command="${1:-help}"
if [[ $# -gt 0 ]]; then
  shift
fi

require_git_repo
require_remote "$upstream_remote"
require_remote "$origin_remote"
require_branch "$upstream_branch"
require_branch "$work_branch"

case "$command" in
  status)
    if [[ "${1:-}" != "--no-fetch" ]]; then
      fetch_upstream
    fi
    show_status
    ;;

  list)
    [[ $# -le 1 ]] || die "list accepts at most one COUNT"
    list_upstream_commits "${1:-40}"
    ;;

  update-main)
    [[ $# -eq 0 ]] || die "update-main takes no positional arguments"
    require_clean_worktree
    fetch_upstream
    pull_main_ff
    ;;

  rebase)
    [[ $# -eq 0 ]] || die "rebase takes no positional arguments"
    require_clean_worktree
    fetch_upstream
    rebase_work_branch
    ;;

  cherry-pick)
    [[ $# -gt 0 ]] || die "cherry-pick requires at least one commit"
    require_clean_worktree
    fetch_upstream
    switch_branch "$work_branch"
    info "cherry-picking: $*"
    git -C "$project_root" cherry-pick "$@"
    if [[ "$push_changes" == true ]]; then
      info "pushing $work_branch to $origin_remote"
      git -C "$project_root" push "$origin_remote" "$work_branch"
    fi
    ;;

  sync)
    [[ $# -eq 0 ]] || die "sync takes no positional arguments"
    require_clean_worktree
    fetch_upstream
    pull_main_ff
    rebase_work_branch
    ;;

  help|-h|--help)
    usage
    ;;

  *)
    usage >&2
    die "unknown command: $command"
    ;;
esac
