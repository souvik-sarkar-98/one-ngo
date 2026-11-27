import { join } from 'node:path';

/**
 * Where the repository's files are, for tests that read them (source scans, schemas,
 * locale catalogues, migrations, allowlists). Tests find files from here, not from their
 * own location, so a test can move without its paths changing.
 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** A path inside the repository. */
export const repoPath = (...parts: string[]): string => join(REPO_ROOT, ...parts);

export const PLATFORM_ROOT = repoPath('packages', 'platform');
export const PRODUCT_ROOT = repoPath('packages', 'product');

/** The log metrics, alert policies and dashboard a person applies with gcloud (its README says how). */
export const MONITORING_DIR = repoPath('docs', 'monitoring');

/** Data files the tests read: allowlists, baselines and fixtures, in a folder per package. */
export const SUPPORT_DIR = repoPath('tests', 'support');
