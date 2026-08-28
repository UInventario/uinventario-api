#!/usr/bin/env sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <dev|prod> <project-id> <branch>" >&2
  exit 2
fi

environment="$1"
project_id="$2"
branch="$3"

case "$environment" in
  dev)
    expected_project="software-inventario-dev"
    expected_branch="develop"
    ;;
  prod)
    expected_project="software-inventario-prod"
    expected_branch="master"
    ;;
  *)
    echo "Environment must be dev or prod." >&2
    exit 2
    ;;
esac

if [ "$project_id" != "$expected_project" ]; then
  echo "Refusing $environment deployment to project $project_id; expected $expected_project." >&2
  exit 3
fi

if [ "$branch" != "$expected_branch" ]; then
  echo "Refusing $environment deployment from branch $branch; expected $expected_branch." >&2
  exit 4
fi

printf 'Validated %s deployment: %s -> %s\n' "$environment" "$branch" "$project_id"
