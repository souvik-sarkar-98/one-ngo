import { DEFAULT_FY_START_MONTH, FY_START_SETTING, fiscalYearKey, numberingPeriod } from '../../../packages/platform/src/domain/ledger/fiscal-year.js';
import { transactions } from '../../../packages/platform/src/infrastructure/postgres/tx.js';
import { joinTx } from '../../../packages/platform/src/domain/transaction-scope.js';
import { defineProviderContract } from '../../../packages/platform/src/infrastructure/contract-tests/contract.js';
import { postgresProvider } from '../../../packages/platform/src/infrastructure/contract-tests/postgres/fixture.js';

defineProviderContract(postgresProvider({ transactions, joinTx, fiscalYear: { settingKey: FY_START_SETTING, defaultStartMonth: DEFAULT_FY_START_MONTH, fiscalYearKey, numberingPeriod } }));
