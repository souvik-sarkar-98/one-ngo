import type { Logger } from '@onengo/kernel/ports';

export const silentLogger: Logger = { log: () => undefined };
