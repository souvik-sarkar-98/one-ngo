import { sql } from 'kysely';
import type { AccountChoices } from '../../../runtime/definitions/ports/account-choices.js';
import { pg } from '../tx.js';

const TENANT = sql<string>`app_tenant()`;

const active = (tx: Parameters<typeof pg>[0]) =>
  pg(tx)
    .selectFrom('money_account as m')
    .innerJoin('ledger_account as a', 'a.id', 'm.ledger_account_id')
    .where('m.tenant_id', '=', TENANT)
    .where('m.status', '=', 'active')
    .orderBy('m.kind')
    .orderBy('m.name');

export const pgAccountChoices: AccountChoices = {
  async moneyAccounts(tx) {
    const rows = await active(tx).select(['a.code', 'm.name']).execute();
    return rows.map((r) => ({ value: r.code, label: r.name }));
  },

  async moneyAccountsByKey(tx, filter) {
    const rows = await active(tx)
      .select(['m.key', 'm.name'])
      .$if(!!filter?.upi, (qb) => qb.where('m.upi_id', 'is not', null))
      .execute();
    return rows.map((r) => ({ value: r.key, label: r.name }));
  },
};
