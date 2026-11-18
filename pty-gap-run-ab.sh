#!/bin/sh
# Interleaved A/B on Omarchy: A = merge-base prod files, B = HEAD prod files; probe file identical in both.
set -e
BASE=$1
FILES=$(git diff --name-only --diff-filter=M "$BASE" HEAD -- src/main | grep -v '\.test\.ts$' | grep -v probe)
for arm in B A B A B A; do
  if [ "$arm" = A ]; then git checkout "$BASE" -- $FILES; else git checkout HEAD -- $FILES; fi
  STORM_ARM=$arm pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/terminal/output/pty-gap-storm-probe.test.ts 2>&1 | grep '\[gap-storm\]'
done
git checkout HEAD -- $FILES
