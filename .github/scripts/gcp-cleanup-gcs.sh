#!/usr/bin/env bash
#
# Deletes stale files from the App Engine staging bucket.
# Used by .github/workflows/cleanup.yml.
#
# Required environment:
#   GCP_PROJECT_ID  Target project.
#   STALE_DAYS      Age threshold in days.
#   DRY_RUN         "true" reports without deleting.
#
# Appends to cleanup-summary.md and writes gcs_deleted to $GITHUB_OUTPUT.
# The count is how many files were deleted. A dry run deletes none.

set -euo pipefail

echo "" >> cleanup-summary.md
echo "## Staging bucket" >> cleanup-summary.md

STAGING_BUCKET="staging.${GCP_PROJECT_ID}.appspot.com"
CUTOFF_DATE=$(date -u -d "${STALE_DAYS} days ago" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
  || date -u -v-"${STALE_DAYS}d" '+%Y-%m-%dT%H:%M:%SZ')

STALE_FILES=$(gsutil ls -l "gs://${STAGING_BUCKET}/**" 2>/dev/null \
  | awk -v cutoff="$CUTOFF_DATE" 'NF==3 && $2 < cutoff {print $3}' \
  || echo "")

COUNT=$(printf '%s\n' "$STALE_FILES" | grep -c '[^[:space:]]' || true)
COUNT=${COUNT:-0}
echo "| ${STAGING_BUCKET} | Files older than ${STALE_DAYS} days: ${COUNT} |" >> cleanup-summary.md

DELETED=0
if [[ -n "$STALE_FILES" && "$DRY_RUN" == "false" ]]; then
  while read -r f; do
    if [[ -n "$f" ]] && gsutil rm "$f" 2>/dev/null; then
      DELETED=$(( DELETED + 1 ))
    fi
  done <<< "$STALE_FILES"
fi

echo "gcs_deleted=$DELETED" >> "$GITHUB_OUTPUT"
