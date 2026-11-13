#!/usr/bin/env bash
#
# Writes the job summary for .github/workflows/cleanup.yml.
#
# Required environment:
#   TARGET_ENV   Environment name.
#   DRY_RUN      "true" adds the dry-run notice.
#   GAE_DELETED / GCS_DELETED / AR_DELETED   How many were deleted. Blank is 0.

set -euo pipefail

{
  echo "## Cleanup — \`${TARGET_ENV}\`"
  echo ""
  echo "| Resource | Deleted |"
  echo "| --- | --- |"
  echo "| App Engine versions | ${GAE_DELETED:-0} |"
  echo "| Staging files | ${GCS_DELETED:-0} |"
  echo "| Untagged images | ${AR_DELETED:-0} |"
  echo ""
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "Dry run. Nothing was deleted. The report artifact lists what a real run would remove."
  fi
} >> "$GITHUB_STEP_SUMMARY"
