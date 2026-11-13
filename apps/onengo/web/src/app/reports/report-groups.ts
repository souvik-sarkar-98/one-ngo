export interface RunnableReport {
  key: string;
  label: string;
  group: { key: string; label: string; order?: number } | null;
}

export interface ReportSection {
  key: string;
  label: string;
  collapsed: boolean;
  reports: { key: string; label: string; link: string }[];
}

/** One section per report group, then Other for reports in no group. A collapsed section stays closed. */
export function reportSections(reports: RunnableReport[], collapsed: ReadonlySet<string>, otherLabel: string): ReportSection[] {
  const groups = new Map<string, { label: string; order: number; reports: RunnableReport[] }>();
  const other: RunnableReport[] = [];
  for (const report of reports) {
    if (!report.group) {
      other.push(report);
      continue;
    }
    const current = groups.get(report.group.key) ?? { label: report.group.label, order: report.group.order ?? 1000, reports: [] };
    current.reports.push(report);
    groups.set(report.group.key, current);
  }
  const section = (key: string, label: string, items: RunnableReport[]): ReportSection => ({
    key,
    label,
    collapsed: collapsed.has(key),
    reports: items.map((item) => ({ key: item.key, label: item.label, link: `/reports/${encodeURIComponent(item.key)}` })),
  });
  const sections = [...groups.entries()]
    .sort((a, b) => a[1].order - b[1].order || a[1].label.localeCompare(b[1].label))
    .map(([key, group]) => section(key, group.label, group.reports));
  if (other.length) sections.push(section('other', otherLabel, other));
  return sections;
}
