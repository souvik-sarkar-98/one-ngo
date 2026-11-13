export interface Bucket {
  key: string;
  label: string;
  value: number;
}

export interface ChartBox {
  width: number;
  height: number;
  /** Space left of the plot for the axis labels. */
  left: number;
  /** Space below the plot for the bucket labels. */
  bottom: number;
}

export interface ChartGeometry {
  ticks: { value: number; y: number }[];
  bars: { key: string; label: string; value: number; x: number; y: number; width: number; height: number; cx: number }[];
  /** SVG path through the bucket values, for line charts. */
  line: string;
  baseline: number;
}

/** The smallest 1, 2, 2.5 or 5 times a power of ten that is at least `n`. */
export function niceCeil(n: number): number {
  if (!(n > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  const f = n / p;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * p;
}

/** Evenly spaced axis values from 0 to a round maximum at or above the largest value. */
export function axisTicks(max: number, count = 4): number[] {
  const step = niceCeil((max > 0 ? max : 1) / count);
  const top = Math.ceil((max > 0 ? max : 1) / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Positions of the bars, the line and the axis for buckets drawn in `box`. Negative values are drawn as zero. */
export function chartGeometry(buckets: Bucket[], box: ChartBox): ChartGeometry {
  const ticks = axisTicks(Math.max(0, ...buckets.map((b) => b.value)));
  const top = ticks[ticks.length - 1]!;
  const plotWidth = Math.max(0, box.width - box.left);
  const plotHeight = Math.max(0, box.height - box.bottom);
  const y = (v: number) => round(plotHeight - (Math.max(0, v) / top) * plotHeight);
  const slot = buckets.length ? plotWidth / buckets.length : 0;
  const barWidth = round(slot * 0.6);
  const bars = buckets.map((b, i) => {
    const x = round(box.left + i * slot + (slot - barWidth) / 2);
    const by = y(b.value);
    return { key: b.key, label: b.label, value: b.value, x, y: by, width: barWidth, height: round(plotHeight - by), cx: round(box.left + i * slot + slot / 2) };
  });
  const line = bars.map((b, i) => `${i ? 'L' : 'M'}${b.cx} ${b.y}`).join(' ');
  return { ticks: ticks.map((value) => ({ value, y: y(value) })), bars, line, baseline: round(plotHeight) };
}
