import type { Routes } from '@angular/router';
import { provideFieldDates } from '../ui/date-adapter';
import { PublicFormScreen } from './public-form.screen';
import { PublicRecordScreen } from './public-record.screen';

/** A public form can ask for a date, so its date picker needs the adapter. Loaded only when a form opens. */
export const PUBLIC_FORM_ROUTES: Routes = [{ path: '', providers: [provideFieldDates()], component: PublicFormScreen }];

/** The applicant's own view and edit page, which draws the same fields. */
export const PUBLIC_RECORD_ROUTES: Routes = [{ path: '', providers: [provideFieldDates()], component: PublicRecordScreen }];
