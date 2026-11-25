/** Finds organisations that have cleanup work, across every organisation. */
export interface RetentionScan {
  tenantsWithStaleUploads(unlinkedHours: number): Promise<string[]>;
  /** Organisations with a finished or failed data migration, not yet purged, last changed more than `days` days ago. */
  tenantsWithExpiredMigrations(days: number): Promise<string[]>;
}
