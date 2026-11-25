/** The name used when the server cannot be asked, and the name when it is not configured. */
export const DEFAULT_PRODUCT_NAME = 'OneNGO';

let productName = DEFAULT_PRODUCT_NAME;

/**
 * Reads the product name the server is configured with (`ONENGO_PRODUCT_NAME`).
 * Call once before the app is loaded. Never rejects: when the server cannot be
 * reached, or offline, the default stays.
 */
export async function loadProductName(): Promise<void> {
  try {
    const response = await fetch('/api/product', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (!response.ok) return;
    const body = (await response.json()) as { name?: unknown };
    if (typeof body.name === 'string' && body.name !== '') productName = body.name;
  } catch {
    // Keep the default.
  }
}

/** The name loaded at start-up, or the default. */
export const currentProductName = (): string => productName;
