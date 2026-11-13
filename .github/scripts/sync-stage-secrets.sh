#!/usr/bin/env bash
# Stores stage secret values in Secret Manager and lets the matching runtime
# service account read them. Values come from the environment and are not printed.
#
# Required: PROJECT, MAIN_RUNTIME_SA, CONSOLE_RUNTIME_SA, and every value named below.

set -euo pipefail

put() {
  local id="$1" value="$2" sa="$3"
  if [[ -z "$value" ]]; then
    echo "::error::A stage secret value is empty: $id"
    exit 1
  fi
  if gcloud secrets describe "$id" --project "$PROJECT" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$id" --project "$PROJECT" --data-file=- >/dev/null
  else
    printf '%s' "$value" | gcloud secrets create "$id" --project "$PROJECT" --replication-policy=automatic --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$id" --project "$PROJECT" \
    --member="serviceAccount:${sa}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
  echo "Stored ${id}"
}

put ngo-database-system-url "$SYSTEM_DATABASE_URL" "$MAIN_RUNTIME_SA"
put ngo-database-runtime-url "$RUNTIME_DATABASE_URL" "$MAIN_RUNTIME_SA"
put ngo-token-secret "$TOKEN_SECRET" "$MAIN_RUNTIME_SA"
put ngo-encryption-key "$ENCRYPTION_KEY" "$MAIN_RUNTIME_SA"
# The console writes organisation sign-in secrets the main server reads, so it reads the same key.
gcloud secrets add-iam-policy-binding ngo-encryption-key --project "$PROJECT" \
  --member="serviceAccount:${CONSOLE_RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
put ngo-tick-secret "$TICK_SECRET" "$MAIN_RUNTIME_SA"
put ngo-console-database-url "$CONSOLE_DATABASE_URL" "$CONSOLE_RUNTIME_SA"
put ngo-console-runtime-url "$CONSOLE_RUNTIME_URL" "$CONSOLE_RUNTIME_SA"
put ngo-console-encryption-key "$CONSOLE_ENCRYPTION_KEY" "$CONSOLE_RUNTIME_SA"
put ngo-console-internal-token-secret "$CONSOLE_INTERNAL_TOKEN_SECRET" "$CONSOLE_RUNTIME_SA"
put ngo-console-oidc-client-secret "$CONSOLE_OIDC_CLIENT_SECRET" "$CONSOLE_RUNTIME_SA"
