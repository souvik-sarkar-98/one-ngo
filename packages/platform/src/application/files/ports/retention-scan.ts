/** Finds organisations that have cleanup work, across every organisation. */
export interface RetentionScan {
  tenantsWithStaleUploads(unlinkedHours: number): Promise<string[]>;
}
