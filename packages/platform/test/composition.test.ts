import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectEdges, compositionHits, ROOT, sources, type Source } from './layer-graph.js';

const keysOf = (hits: Map<string, unknown>) => [...hits.keys()].sort();

const ENTRY_POINTS = ['src/prepare-deployment.ts'];

/** Root and composition files an entry point reaches through relative imports. */
function reach(entry: string): Set<string> {
  const edges = collectEdges(sources());
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const from = queue.pop()!;
    for (const e of edges) {
      if (e.from === from && !e.typeOnly && !seen.has(e.to) && (!e.to.slice(4).includes('/') || e.to.startsWith('src/composition/') || e.to.startsWith('src/api/'))) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return seen;
}

/**
 * The audit trail is injected: composition builds it (src/composition/infrastructure.ts) and hands it to every
 * service that writes audit or outbox events. The domain port holds only the type, with no module-level binding.
 */
describe('audit trail injection', () => {
  it('keeps no module-level binding in the domain port', () => {
    const port = readFileSync(join(ROOT, 'src/domain/ports/audit-trail.ts'), 'utf8');
    expect(port).not.toMatch(/\bbindAuditTrail\b|\bauditTrailBound\b|\brecordAudit\b|\bqueueEvent\b|^\s*let\s/m);
    expect(port).not.toContain('No audit trail is bound');
  });

  it('is built once by composition and found nowhere else as a binding', () => {
    expect(readFileSync(join(ROOT, 'src/composition/infrastructure.ts'), 'utf8')).toContain('audit: pgAuditTrail');
    const binders = sources()
      .filter((f) => /\b(bindAuditTrail|bindAuditAdapter|auditTrailBound)\b/.test(f.src))
      .map((f) => f.path);
    expect(binders).toEqual([]);
  });

  it.each(ENTRY_POINTS)('is reached by %s through platform.ts', (entry) => {
    expect(reach(entry).has('src/platform.ts'), `${entry} must import platform.ts, directly or through its sibling files.`).toBe(true);
  });
});
/**
 * src/composition/ is wiring only (block G): it builds objects and hands them their collaborators. It holds no
 * transaction (withTenant, asSystem, asTx, joinTx), no audit write (audit.audit, audit.event) and no request
 * handling (fastify imports, req, reply).
 */
describe('composition is wiring only', () => {
  const at = (path: string, src: string): Source => ({ path, src });

  it('holds no transaction, audit write or request handling', () => {
    const hits = compositionHits(sources());
    expect([...hits.keys()], 'Wiring only: move transactions, audit writes and request handling into an application use case or an infrastructure adapter.').toEqual([]);
  });

  it('flags a transaction, an audit write and request handling, and allows plain wiring', () => {
    const hits = compositionHits([
      at(
        'src/composition/a.ts',
        [
          "import Fastify from 'fastify';",
          "import { transactions } from '../domain/ports/transaction.js';",
          'const tm = transactions(db);',
          'export const run = (p: P) => p.transactions.withTenant(id, (tx) => p.audit.audit(tx, {}));',
          'const event = (tx: T) => audit.event(tx, "x", {});',
          'const open = () => db.withTenant(id, async (tx) => joinTx(id, asTx(tx)));',
          'const system = () => db.asSystem(async () => 1);',
          'const handler = (req: Req, reply: Reply) => reply.send(req.body);',
        ].join('\n'),
      ),
      at('src/composition/b.ts', ['const service = new Service(tm, store, audit);', 'const logger = base.logger.log("x");', 'const tm = transactions(db);'].join('\n')),
      at('src/http/c.ts', 'export const run = (p: P) => p.transactions.withTenant(id, (tx) => p.audit.audit(tx, {}));'),
    ]);
    expect(keysOf(hits)).toEqual([
      'composition: src/composition/a.ts: audit write audit.audit x1',
      'composition: src/composition/a.ts: audit write audit.event x1',
      'composition: src/composition/a.ts: request handling import fastify x1',
      'composition: src/composition/a.ts: request handling parameter reply x1',
      'composition: src/composition/a.ts: request handling parameter req x1',
      'composition: src/composition/a.ts: request handling use of reply x1',
      'composition: src/composition/a.ts: request handling use of req x1',
      'composition: src/composition/a.ts: transaction call asSystem x1',
      'composition: src/composition/a.ts: transaction call asTx x1',
      'composition: src/composition/a.ts: transaction call joinTx x1',
      'composition: src/composition/a.ts: transaction call withTenant x2',
    ]);
    expect([...hits.values()].every((h) => h.block === 'C')).toBe(true);
  });

  it('counts calls per file, so one more call in a file with pending work is a new violation', () => {
    const one = compositionHits([at('src/composition/a.ts', 'db.withTenant(id, f);')]);
    const two = compositionHits([at('src/composition/a.ts', 'db.withTenant(id, f);\ndb.withTenant(id, g);')]);
    expect(keysOf(one)).toEqual(['composition: src/composition/a.ts: transaction call withTenant x1']);
    expect(keysOf(two)).toEqual(['composition: src/composition/a.ts: transaction call withTenant x2']);
  });
});
