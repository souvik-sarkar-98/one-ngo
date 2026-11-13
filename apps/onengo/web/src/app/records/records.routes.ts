import type { Routes } from '@angular/router';
import { provideFieldDates } from '../ui/date-adapter';
import { RecordListScreen } from './record-list.screen';

/** Loaded only when a record list opens, so Material stays out of the first download. */
export const RECORD_ROUTES: Routes = [{ path: '', providers: [provideFieldDates()], component: RecordListScreen }];
