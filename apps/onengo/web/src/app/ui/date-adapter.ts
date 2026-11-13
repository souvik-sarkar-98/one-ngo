import { DateAdapter, MAT_DATE_FORMATS, NativeDateAdapter, type MatDateFormats } from '@angular/material/core';
import { formatFieldDate, parseFieldDate, type FieldDateStyle } from './date-text';

class FieldDateAdapter extends NativeDateAdapter {
  override format(date: Date, displayFormat: FieldDateStyle): string {
    return formatFieldDate(date, displayFormat);
  }

  override parse(value: unknown, parseFormat?: unknown): Date | null {
    return (typeof value === 'string' ? parseFieldDate(value) : null) ?? super.parse(value, parseFormat);
  }
}

const FIELD_DATE_FORMATS: MatDateFormats = {
  parse: { dateInput: null, timeInput: null },
  display: {
    dateInput: 'date',
    monthLabel: 'monthYear',
    monthYearLabel: 'monthYear',
    dateA11yLabel: 'longDate',
    monthYearA11yLabel: 'longMonthYear',
    timeInput: 'time',
    timeOptionLabel: 'time',
  } satisfies Record<string, FieldDateStyle>,
};

/** Dates for the form fields' date pickers; provide it on the routes that show forms. */
export function provideFieldDates() {
  return [
    { provide: DateAdapter, useClass: FieldDateAdapter },
    { provide: MAT_DATE_FORMATS, useValue: FIELD_DATE_FORMATS },
  ];
}
