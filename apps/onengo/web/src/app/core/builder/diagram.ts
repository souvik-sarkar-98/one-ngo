/** One box of a diagram. */
export interface DiagramNode {
  id: string;
  label: string;
  /** A short second line, such as "start · final". */
  note?: string;
  tone?: 'start' | 'final' | 'plain';
}

/** One arrow between two boxes; several may join the same pair. */
export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  tone?: 'accent' | 'plain';
}

export interface PlacedNode extends DiagramNode {
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
  row: number;
  /** False when no arrow leads to it from the start. */
  reachable: boolean;
}

export interface PlacedEdge extends DiagramEdge {
  /** SVG path data. */
  path: string;
  labelX: number;
  labelY: number;
  /** The arrow goes back to an earlier column (or its own); drawn below the boxes or as a loop above. */
  back: boolean;
}

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  columnGap: number;
  rowGap: number;
  padding: number;
}

const DEFAULTS: LayoutOptions = { nodeWidth: 150, nodeHeight: 48, columnGap: 120, rowGap: 36, padding: 16 };
const SPREAD = 14;
const LOOP = 44;
const BELOW = 40;

type Point = { x: number; y: number };
const mid = (p0: Point, p1: Point, p2: Point, p3: Point): Point => ({
  x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
  y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
});
const curve = (p0: Point, p1: Point, p2: Point, p3: Point) => `M${p0.x} ${p0.y} C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`;

/** The distance in arrows from the start to every node it reaches. */
export function distances(start: string, nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, number>();
  if (!ids.has(start)) return out;
  out.set(start, 0);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    for (const e of edges) {
      if (e.from === at && ids.has(e.to) && !out.has(e.to)) {
        out.set(e.to, out.get(at)! + 1);
        queue.push(e.to);
      }
    }
  }
  return out;
}

/** Each node's column: its distance in arrows from the start; nodes the start cannot reach get the column after the last. */
export function columnsFrom(start: string, nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): Map<string, number> {
  const out = distances(start, nodes, edges);
  const last = Math.max(-1, ...out.values()) + 1;
  for (const n of nodes) if (!out.has(n.id)) out.set(n.id, last);
  return out;
}

/**
 * A layered left-to-right layout: columns by distance from the start node,
 * rows in the given order and centred in each column; forward arrows as
 * curves between columns, arrows back as curves below the boxes, and an
 * arrow to the same box as a loop above it.
 */
export function layoutDiagram(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[], start: string, options: Partial<LayoutOptions> = {}): DiagramLayout {
  const o = { ...DEFAULTS, ...options };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const known = edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const reached = distances(start, nodes, known);
  const columns = columnsFrom(start, nodes, known);
  const loops = known.some((e) => e.from === e.to);
  const top = o.padding + (loops ? LOOP : 0);

  const counts = new Map<number, number>();
  const rows = new Map<string, number>();
  for (const n of nodes) {
    const c = columns.get(n.id)!;
    rows.set(n.id, counts.get(c) ?? 0);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const most = Math.max(0, ...counts.values());
  const stepY = o.nodeHeight + o.rowGap;

  const placed: PlacedNode[] = nodes.map((n) => {
    const column = columns.get(n.id)!;
    const row = rows.get(n.id)!;
    const offset = ((most - counts.get(column)!) * stepY) / 2;
    return {
      ...n,
      column,
      row,
      x: o.padding + column * (o.nodeWidth + o.columnGap),
      y: top + offset + row * stepY,
      width: o.nodeWidth,
      height: o.nodeHeight,
      reachable: reached.has(n.id),
    };
  });
  const at = new Map(placed.map((p) => [p.id, p]));
  const boxesBottom = top + Math.max(0, most * stepY - o.rowGap);

  const pairs = new Map<string, DiagramEdge[]>();
  for (const e of known) {
    const id = `${e.from}\u0000${e.to}`;
    pairs.set(id, [...(pairs.get(id) ?? []), e]);
  }
  let lowest = boxesBottom;
  const placedEdges: PlacedEdge[] = known.map((e) => {
    const group = pairs.get(`${e.from}\u0000${e.to}`)!;
    const k = group.indexOf(e);
    const spread = (k - (group.length - 1) / 2) * SPREAD;
    const a = at.get(e.from)!;
    const b = at.get(e.to)!;
    if (a === b) {
      const l = { x: a.x + a.width * 0.65 + spread, y: a.y };
      const r = { x: a.x + a.width * 0.35 + spread, y: a.y };
      const lift = LOOP - 6 - k * 6;
      const c1 = { x: l.x + 20, y: a.y - lift };
      const c2 = { x: r.x - 20, y: a.y - lift };
      const m = mid(l, c1, c2, r);
      return { ...e, back: true, path: curve(l, c1, c2, r), labelX: m.x, labelY: m.y };
    }
    if (b.column > a.column) {
      const p0 = { x: a.x + a.width, y: a.y + a.height / 2 + spread };
      const p3 = { x: b.x, y: b.y + b.height / 2 + spread };
      const dx = (p3.x - p0.x) / 2;
      const c1 = { x: p0.x + dx, y: p0.y };
      const c2 = { x: p3.x - dx, y: p3.y };
      const m = mid(p0, c1, c2, p3);
      return { ...e, back: false, path: curve(p0, c1, c2, p3), labelX: m.x, labelY: m.y };
    }
    const p0 = { x: a.x + a.width / 2 + spread, y: a.y + a.height };
    const p3 = { x: b.x + b.width / 2 + spread, y: b.y + b.height };
    const depth = Math.max(p0.y, p3.y) + BELOW + Math.abs(a.column - b.column) * 6 + k * SPREAD;
    const c1 = { x: p0.x, y: depth };
    const c2 = { x: p3.x, y: depth };
    const m = mid(p0, c1, c2, p3);
    lowest = Math.max(lowest, m.y + 12);
    return { ...e, back: true, path: curve(p0, c1, c2, p3), labelX: m.x, labelY: m.y };
  });

  const columnCount = Math.max(0, ...placed.map((p) => p.column + 1));
  return {
    width: o.padding * 2 + Math.max(0, columnCount * o.nodeWidth + (columnCount - 1) * o.columnGap),
    height: lowest + o.padding,
    nodes: placed,
    edges: placedEdges,
  };
}