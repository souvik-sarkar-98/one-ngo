import { DEFAULT_FY_START_MONTH, FY_START_SETTING, fiscalYearKey, numberingPeriod } from '../src/domain/ledger/fiscal-year.js';
import { transactions } from '../src/infrastructure/postgres/tx.js';
import { joinTx } from '../src/domain/transaction-scope.js';
import { defineProviderContract } from '../src/infrastructure/contract-tests/contract.js';
import { postgresProvider } from '../src/infrastructure/contract-tests/postgres/fixture.js';

defineProviderContract(postgresProvider({ transactions, joinTx, fiscalYear: { settingKey: FY_START_SETTING, defaultStartMonth: DEFAULT_FY_START_MONTH, fiscalYearKey, numberingPeriod } }));
