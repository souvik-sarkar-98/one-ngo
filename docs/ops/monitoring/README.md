# Monitoring definitions

**Nothing here is applied automatically.** No build, test, deploy step or server
process reads these files. A person with the Logging Admin and Monitoring Editor
roles on the installation's Google Cloud project applies them once with `gcloud`,
and again after a file changes. Choosing who is notified (the alert channel) is
also that person's decision.

The server writes one JSON log line per event to stdout, which App Engine sends to
Cloud Logging. Entries an alert watches carry a fixed `alert` field:

| `alert` | Severity | Logged when |
| --- | --- | --- |
| `outbox.failed_permanently` | ERROR | A background event failed its fifth and last attempt |
| `job.failed` | ERROR | A background job stopped with an error |
| `http.unhandled_error` | ERROR | A request was answered 500 because of an unexpected error |
| `memory.high` | WARNING | An instance's resident memory is above `MEMORY_ALERT_MB` (default 300) |

| Folder or file | What it is | gcloud command |
| --- | --- | --- |
| `metrics/<name>.json` | Log-based counter metric, one per alert name; the file name is the metric name | `gcloud logging metrics create` |
| `policies/*.json` | Alert policy on that metric (the HTTP one is the error-rate policy) | `gcloud alpha monitoring policies create` |
| `dashboard.json` | The "NGO platform" dashboard: the four metrics, responses by status code, and instance memory | `gcloud monitoring dashboards create` |

## Apply (PowerShell)

```powershell
$project = 'my-ngo-project'
# Metrics first: the policies and the dashboard refer to them.
Get-ChildItem docs/ops/monitoring/metrics/*.json | ForEach-Object {
  gcloud logging metrics create $_.BaseName --project=$project --config-from-file=$_.FullName
}
# Find or create the notification channel (e-mail, SMS, chat) in the console first.
gcloud beta monitoring channels list --project=$project
$channel = "projects/$project/notificationChannels/CHANNEL_ID"
Get-ChildItem docs/ops/monitoring/policies/*.json | ForEach-Object {
  gcloud alpha monitoring policies create --project=$project --policy-from-file=$_.FullName --notification-channels=$channel
}
gcloud monitoring dashboards create --project=$project --config-from-file=docs/ops/monitoring/dashboard.json
```

Running a `create` twice makes a second policy or dashboard. To change one, use
`gcloud logging metrics update <name> --config-from-file=...`,
`gcloud alpha monitoring policies update <policy id> --policy-from-file=...` or
`gcloud monitoring dashboards update <dashboard id> --config-from-file=...`.

## Check that an alert fires

Write one entry that looks like the server's, then wait a few minutes for the
incident and the notification. From Cloud Shell or another Bash shell (Windows
PowerShell mangles the quotes in the JSON):

```bash
gcloud logging write ngo-alert-check '{"alert":"job.failed","kind":"alert-check","message":"Alert check"}' \
  --project=my-ngo-project --payload-type=json --severity=ERROR \
  --monitored-resource-type=gae_app --monitored-resource-labels=module_id=default,version_id=alert-check
```

The incident closes by itself 30 minutes after the last matching entry.

## Notes

- The policies and dashboard filter on `resource.type="gae_app"` (App Engine).
  On another host, change that in each policy and dashboard tile; the metric
  filters match on the `alert` field only.
- `appengine.googleapis.com/system/memory/usage` on the dashboard is App
  Engine's own measurement, summed over a version's instances. `memory.high` is
  the process's own reading, per instance.
- Tune the error-rate threshold (5 per 5 minutes) to the installation's traffic.
