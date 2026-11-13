import { describe, expect, it } from 'vitest';
import type { WorkflowBody } from '../models';
import { columnsFrom, layoutDiagram, type DiagramEdge, type DiagramNode } from './diagram';
import { edgeStep, stateRows, stepRows, unreachableStates, workflowGraph } from './workflow-view';

const n = (id: string): DiagramNode => ({ id, label: id.toUpperCase() });
const e = (id: string, from: string, to: string): DiagramEdge => ({ id, from, to, label: id });
const opts = { nodeWidth: 100, nodeHeight: 40, columnGap: 60, rowGap: 20, padding: 10 };

describe('diagram layout', () => {
  it('puts each node in the column of its distance from the start', () => {
    const nodes = ['a', 'b', 'c', 'd'].map(n);
    const edges = [e('ab', 'a', 'b'), e('bc', 'b', 'c'), e('ac', 'a', 'c'), e('cd', 'c', 'd')];
    expect(Object.fromEntries(columnsFrom('a', nodes, edges))).toEqual({ a: 0, b: 1, c: 1, d: 2 });
  });

  it('places columns left to right and centres shorter columns', () => {
    const l = layoutDiagram(['raised', 'paid', 'cancelled'].map(n), [e('pay', 'raised', 'paid'), e('cancel', 'raised', 'cancelled')], 'raised', opts);
    const at = Object.fromEntries(l.nodes.map((p) => [p.id, p]));
    expect([at['raised']!.column, at['paid']!.column, at['cancelled']!.column]).toEqual([0, 1, 1]);
    expect([at['paid']!.row, at['cancelled']!.row]).toEqual([0, 1]);
    expect(at['raised']!.x).toBe(10);
    expect(at['paid']!.x).toBe(10 + 100 + 60);
    expect(at['paid']!.y).toBe(10);
    expect(at['cancelled']!.y).toBe(10 + 40 + 20);
    expect(at['raised']!.y).toBe(10 + 30);
    expect(l.width).toBe(10 * 2 + 2 * 100 + 60);
    expect(l.height).toBe(10 + 100 + 10);
  });

  it('draws forward arrows from the right edge to the left edge with the label between', () => {
    const l = layoutDiagram([n('a'), n('b')], [e('go', 'a', 'b')], 'a', opts);
    const edge = l.edges[0]!;
    expect(edge.back).toBe(false);
    expect(edge.path.startsWith('M110 30 ')).toBe(true);
    expect(edge.path.endsWith(' 170 30')).toBe(true);
    expect(edge.labelX).toBe(140);
    expect(edge.labelY).toBe(30);
  });

  it('sends arrows back below the boxes and grows the height for them', () => {
    const plain = layoutDiagram([n('a'), n('b')], [e('go', 'a', 'b')], 'a', opts);
    const l = layoutDiagram([n('a'), n('b')], [e('go', 'a', 'b'), e('reopen', 'b', 'a')], 'a', opts);
    const back = l.edges.find((x) => x.id === 'reopen')!;
    expect(back.back).toBe(true);
    expect(back.labelY).toBeGreaterThan(10 + 40);
    expect(l.height).toBeGreaterThan(plain.height);
    expect(back.labelY).toBeLessThan(l.height);
  });

  it('draws an arrow to the same box as a loop above it, with room at the top', () => {
    const l = layoutDiagram([n('a')], [e('again', 'a', 'a')], 'a', opts);
    const loop = l.edges[0]!;
    expect(loop.back).toBe(true);
    expect(l.nodes[0]!.y).toBeGreaterThan(10);
    expect(loop.labelY).toBeLessThan(l.nodes[0]!.y);
    expect(loop.labelY).toBeGreaterThan(0);
  });

  it('spreads several arrows between the same two boxes', () => {
    const l = layoutDiagram([n('a'), n('b')], [e('one', 'a', 'b'), e('two', 'a', 'b')], 'a', opts);
    const [one, two] = l.edges;
    expect(one!.labelY).not.toBe(two!.labelY);
    expect(one!.labelY + two!.labelY).toBe(60);
  });

  it('puts nodes the start cannot reach in a last column, marked unreachable', () => {
    const l = layoutDiagram([n('a'), n('b'), n('lost')], [e('go', 'a', 'b')], 'a', opts);
    const lost = l.nodes.find((p) => p.id === 'lost')!;
    expect(lost.column).toBe(2);
    expect(lost.reachable).toBe(false);
    expect(l.nodes.filter((p) => p.reachable).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('ignores arrows to unknown nodes and lays out an empty diagram', () => {
    const l = layoutDiagram([n('a')], [e('x', 'a', 'ghost')], 'a', opts);
    expect(l.edges).toEqual([]);
    const empty = layoutDiagram([], [], 'a', opts);
    expect(empty.nodes).toEqual([]);
    expect(empty.width).toBe(20);
  });

  it('without a known start every node is unreachable in the first column', () => {
    const l = layoutDiagram([n('a'), n('b')], [e('go', 'a', 'b')], 'nope', opts);
    expect(l.nodes.map((p) => [p.column, p.reachable])).toEqual([
      [0, false],
      [0, false],
    ]);
  });
});

const DONATION: WorkflowBody = {
  key: 'donation',
  recordType: 'donation',
  initial: 'raised',
  states: [
    { key: 'raised', label: 'Raised' },
    { key: 'paid', label: 'Paid', final: true, locked: true },
    { key: 'cancelled', label: 'Cancelled', final: true },
    { key: 'archived', label: 'Archived' },
  ],
  transitions: [
    { key: 'markPaid', label: 'Mark as paid', from: ['raised'], to: 'paid', requiredFields: ['method'], approval: { roles: ['treasurer'], count: 1 } },
    { key: 'cancel', label: 'Cancel', from: ['raised', 'paid'], to: 'cancelled', permission: 'finance:cancel' },
  ],
};

describe('workflow diagram and tables', () => {
  it('turns states into boxes and each start state of a step into an arrow', () => {
    const g = workflowGraph(DONATION);
    expect(g.nodes.map((x) => [x.id, x.tone, x.note ?? ''])).toEqual([
      ['raised', 'start', 'start'],
      ['paid', 'final', 'Final · Locked'],
      ['cancelled', 'final', 'Final'],
      ['archived', 'plain', ''],
    ]);
    expect(g.edges.map((x) => [x.from, x.to, x.label, x.tone])).toEqual([
      ['raised', 'paid', 'Mark as paid · Approval', 'accent'],
      ['raised', 'cancelled', 'Cancel', 'plain'],
      ['paid', 'cancelled', 'Cancel', 'plain'],
    ]);
    expect(g.edges.map((x) => edgeStep(x.id))).toEqual(['markPaid', 'cancel', 'cancel']);
  });

  it('names the states no step leads to', () => {
    expect(unreachableStates(DONATION)).toEqual(['Archived']);
  });

  it('shows states and steps as table rows', () => {
    expect(stateRows(DONATION).map((r) => r.cells.map((c) => c.value))).toEqual([
      ['Raised', '●', '', ''],
      ['Paid', '', '✓', '✓'],
      ['Cancelled', '', '✓', ''],
      ['Archived', '', '', ''],
    ]);
    const steps = stepRows(DONATION, [{ key: 'method', label: 'Method', type: 'text' }]);
    expect(steps[0]!.cells.map((c) => c.value)).toEqual(['Mark as paid', 'Raised → Paid', 'Method', 'record:donation:transition:markPaid', '1 of treasurer']);
    expect(steps[0]!.badge).toEqual({ label: '1 of treasurer', tone: 'warning' });
    expect(steps[1]!.cells.map((c) => c.value)).toEqual(['Cancel', 'Raised, Paid → Cancelled', '—', 'finance:cancel', '—']);
  });
});
