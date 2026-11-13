import { PlatformError } from '@onengo/kernel/errors';
import { InfrastructureError } from '@onengo/kernel/errors';

/** The platform error an infrastructure error stands for: same code, message and issues. */
export function platformErrorOf(error: InfrastructureError): PlatformError {
  return new PlatformError(error.code, error.message, error.issues);
}

const translate = (error: unknown): unknown => (error instanceof InfrastructureError ? platformErrorOf(error) : error);

/**
 * An infrastructure port as the core sees it: whatever the port throws or rejects with, an
 * `InfrastructureError` arrives as the `PlatformError` it stands for, and everything else is untouched.
 * Methods run on the original object, so the port's own internal calls are not translated twice.
 */
export function atPortBoundary<T extends object>(port: T): T {
  return new Proxy(port, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result instanceof Promise ? result.catch((e: unknown) => Promise.reject(translate(e))) : result;
        } catch (e) {
          throw translate(e);
        }
      };
    },
  });
}
