#!/usr/bin/env bash
# Fails when forbidden vocabulary appears under dev-factory/. The words are assembled from
# fragments so this file does not trip its own check.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
a='co'; b='work'; c='lab'; d='night'; e='day'; f='shift'
PATTERN="${a}[-_ ]?${b}|${a}[-_ ]?${c}|${d}[-_ ]?${f}|${e}[-_ ]?${f}"
if grep -rniE "$PATTERN" "$DIR" --exclude-dir=node_modules --exclude=lint-vocabulary.sh; then
  echo "lint-vocabulary: forbidden vocabulary found (see above)" >&2
  exit 1
fi
echo "lint-vocabulary: ok"
