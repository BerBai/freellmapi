#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

if [[ ! -x node_modules/.bin/tsx ]]; then
  echo "prepare-from-db: dependencies are missing; run npm ci in $repo_root" >&2
  exit 1
fi

exec node_modules/.bin/tsx fork/catalog/src/prepare-from-db.mjs "$@"
