import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineDefinitionContract } from './definitions.contract.js';
import { defineIndexContract } from './indexes.contract.js';
import { defineJobContract } from './jobs.contract.js';
import { defineLedgerContract } from './ledger.contract.js';
import { defineMigrationContract } from './migrations.contract.js';
import { defineOutboxContract } from './outbox.contract.js';
import type { ProviderUnderTest, ProviderWorld } from './provider.js';
import { defineReceiptContract } from './receipts.contract.js';
import { defineRecordContract } from './records.contract.js';
import { defineTenancyContract } from './tenancy.contract.js';
import { defineTransactionContract } from './transactions.contract.js';

/**
 * The provider-neutral database contract (section 11 of
 * docs/architecture/ngo-backend-enhancement-plan.md). Every supported provider
 * runs it in full; a provider migration is not released until it passes.
 */
export function defineProviderContract(provider: ProviderUnderTest): void {
  describe(`${provider.name} database contract`, () => {
    let world: ProviderWorld | undefined;
    const current = (): ProviderWorld => {
      if (!world) throw new Error('The provider world is not open.');
      return world;
    };

    beforeAll(async () => {
      world = await provider.open();
    });
    afterAll(async () => {
      await world?.close();
    });

    describe('capability profile', () => {
      it('names a supported provider and a database-enforced isolation', () => {
        const c = provider.capabilities;
        expect(['postgres', 'mysql']).toContain(c.provider);
        expect(['rls', 'database-per-tenant']).toContain(c.tenantIsolation);
        expect(['native', 'limited']).toContain(c.jsonRecordQueries);
      });
    });

    defineTransactionContract(current);
    defineTenancyContract(current, provider.capabilities);
    defineRecordContract(current, provider.capabilities);
    defineDefinitionContract(current);
    defineLedgerContract(current, provider.capabilities);
    defineReceiptContract(current);
    defineJobContract(current, provider.capabilities);
    defineOutboxContract(current);
    defineIndexContract(current);
    defineMigrationContract(provider);
  });
}
