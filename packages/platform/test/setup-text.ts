import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addText, flattenMessages } from '../../../apps/onengo/web/src/app/core/i18n/i18n';

// The app loads each area's English with its screens; tests exercise every area, so all of it is in place up front.
const dir = join(import.meta.dirname, '../../product/locale');
for (const file of readdirSync(dir).filter((f) => /^en(\.[a-z]+)?\.json$/.test(f))) {
  addText('en', flattenMessages(JSON.parse(readFileSync(join(dir, file), 'utf8'))));
}
