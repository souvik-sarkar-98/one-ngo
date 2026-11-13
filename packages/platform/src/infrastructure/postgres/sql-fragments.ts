import { sql } from 'kysely';

/** SQL fragments the owner-level stores write the same way. */
export const NOW = sql<Date>`now()`;
export const anyText = (names: string[]) => sql<string>`any(${names}::text[])`;
export const minutesFromNow = (minutes: number) => sql<Date>`now() + make_interval(mins => ${minutes})`;
