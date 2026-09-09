#!/usr/bin/env bash
# Regenerate docs/cases.md from a real demo run.
#
# The four cases are selected by the reasoning engine, not written by hand, so
# this captures the engine's own output verbatim rather than paraphrasing it.
set -euo pipefail
out=docs/cases.md
tmp=$(mktemp)
npx tsx scripts/demo.ts > "$tmp" 2>&1

{
  echo "# The four required cases"
  echo
  echo "Captured verbatim from \`npm run demo\`. These are **selected by the reasoning"
  echo "engine from its own output**, not hand-picked: the demo asks for the"
  echo "highest-confidence example of each verdict, preferring cross-document pairs."
  echo "If the engine stops producing one, it prints an absence rather than a fixture."
  echo
  echo "Reproduce with no API key:"
  echo
  echo '```bash'
  echo 'npm run demo'
  echo '```'
  echo
  echo '```text'
  # Skip the ingest preamble; start at the reconciliation summary.
  sed -n '/^Reconciling/,$p' "$tmp"
  echo '```'
} > "$out"

rm -f "$tmp"
echo "wrote $out"
