#!/usr/bin/env bash
#
# Prunes old App Engine versions. Used by .github/workflows/cleanup.yml.
#
# A version is deleted only when it carries no traffic and falls outside the
# newest KEEP_VERSIONS. A version whose traffic split cannot be read is kept.
#
# Required environment:
#   GCP_PROJECT_ID  Target project.
#   KEEP_VERSIONS   Newest versions retained per service, traffic or not.
#   DRY_RUN         "true" reports without deleting.
#   TARGET_ENV      Name used in the report heading.
#
# Appends to cleanup-summary.md and writes gae_deleted to $GITHUB_OUTPUT.

set -euo pipefail

echo "## App Engine versions ($TARGET_ENV)" >> cleanup-summary.md

SERVICES=$(gcloud app services list \
  --project="$GCP_PROJECT_ID" \
  --format='value(id)' 2>/dev/null || echo "")

if [[ -z "$SERVICES" ]]; then
  echo "_No App Engine services found._" >> cleanup-summary.md
  echo "gae_deleted=0" >> "$GITHUB_OUTPUT"
  exit 0
fi

TOTAL_DELETED=0

while IFS= read -r SERVICE; do
  [[ -z "$SERVICE" ]] && continue

  # traffic_split is the field that identifies the live version.
  VERSIONS=$(gcloud app versions list \
    --service="$SERVICE" \
    --project="$GCP_PROJECT_ID" \
    --format='value(id,traffic_split)' \
    --sort-by='~creationTime' 2>/dev/null || echo "")

  POSITION=0
  KEPT=0
  TO_DELETE=()

  while IFS=$'\t' read -r VID SPLIT; do
    [[ -z "$VID" ]] && continue
    POSITION=$(( POSITION + 1 ))
    SPLIT="${SPLIT//[[:space:]]/}"

    if [[ ! "$SPLIT" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
      echo "::warning::Could not read the traffic split for ${SERVICE}/${VID}; keeping it."
      KEPT=$(( KEPT + 1 ))
    elif [[ ! "$SPLIT" =~ ^0(\.0+)?$ ]]; then
      KEPT=$(( KEPT + 1 ))
    elif (( POSITION <= KEEP_VERSIONS )); then
      KEPT=$(( KEPT + 1 ))
    else
      TO_DELETE+=("$VID")
    fi
  done <<< "$VERSIONS"

  if [[ ${#TO_DELETE[@]} -eq 0 ]]; then
    echo "| $SERVICE | No versions to prune (${KEPT} kept) |" >> cleanup-summary.md
    continue
  fi

  DELETE_LIST=$(printf '%s\n' "${TO_DELETE[@]}" | tr '\n' ' ')
  echo "| $SERVICE | Pruning ${#TO_DELETE[@]} version(s): $DELETE_LIST |" >> cleanup-summary.md

  if [[ "$DRY_RUN" == "false" ]]; then
    gcloud app versions delete "${TO_DELETE[@]}" \
      --service="$SERVICE" \
      --project="$GCP_PROJECT_ID" \
      --quiet || echo "::warning::Some versions could not be deleted in $SERVICE"
    TOTAL_DELETED=$(( TOTAL_DELETED + ${#TO_DELETE[@]} ))
  fi
done <<< "$SERVICES"

echo "gae_deleted=$TOTAL_DELETED" >> "$GITHUB_OUTPUT"
