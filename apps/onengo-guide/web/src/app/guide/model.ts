import type { IconName } from '@onengo/web-kit';

/** Phone width from the signed-off UI design: below 760px. */
export const PHONE_QUERY = '(max-width: 759.98px)';

export type LayoutName = 'web' | 'mobile';

export interface StageRow {
  title: string;
  meta: string;
  amount?: string;
  status?: string;
  /** One value per list column. Absent, the four default columns are used. */
  cells?: string[];
}

export interface StageLine {
  label: string;
  value: string;
}

export type StageScreen =
  | { kind: 'signin'; heading: string; detail: string; action: string }
  | { kind: 'home'; greeting: string; groups: { name: string; types: string[] }[] }
  | {
      kind: 'list';
      title: string;
      crumbs: string[];
      chips: string[];
      chip: string;
      search: string;
      pills: string[];
      rows: StageRow[];
      nav: string;
      back: boolean;
      fab: boolean;
      filters?: boolean;
      /** Column headings. Absent, the four default columns are used. */
      columns?: string[];
      /** Buttons for a bulk action, shown above the list. */
      bulk?: string[];
    }
  | {
      kind: 'panel';
      title: string;
      crumbs: string[];
      heading: string;
      lines: StageLine[];
      /** Named groups of lines, for detail sections and the required fields of a step. */
      sections?: { label: string; lines: StageLine[] }[];
      actions: string[];
      /** The action label drawn as the main button. */
      primary?: string;
      confirm?: string;
      nav: string;
    }
  | { kind: 'inbox'; tab: 'Approvals' | 'Notifications'; rows: StageRow[]; badge: number }
  | { kind: 'more'; account: string; detail: string; items: string[] }
  | { kind: 'builder'; title: string; body: string }
  | { kind: 'form'; title: string; crumbs: string[]; fields: StageLine[]; aside: string }
  | { kind: 'lanes'; title: string; lanes: { name: string; steps: string[] }[] }
  | { kind: 'print'; title: string; lines: string[] };

export interface GuideStep {
  title: string;
  action: string;
  path: string;
  mobile: string;
  web: string;
  /**
   * The control this step asks the person to use. The stage draws a yellow
   * outline on the matching control. Tokens: `search`, `sort`, `filters`,
   * `fab`, `heading`, `row`, or `action:`, `nav:`, `chip:`, `field:`, `item:`
   * plus the visible label.
   */
  highlight?: string;
  screen: StageScreen;
}

export interface GuideChapter {
  id: string;
  title: string;
  lead: string;
  /** One line for the home screen. */
  summary?: string;
  steps: GuideStep[];
}

export interface GuideSection {
  id: string;
  label: string;
  icon: IconName;
  source: string;
  chapters: GuideChapter[];
}

/** True when this control is the one the current step points at. */
export function isHighlighted(highlight: string | undefined, token: string): boolean {
  return !!highlight && highlight === token;
}

/** Where a section and chapter pair should open, or a replacement path when either id is unknown. */
export function resolveGuide(sections: readonly GuideSection[], sectionId: string, chapterId: string): { sectionId: string; chapterId: string } {
  const section = sections.find((item) => item.id === sectionId) ?? sections[0];
  if (!section) return { sectionId: 'app', chapterId: 'sign-in' };
  const chapter = section.chapters.find((item) => item.id === chapterId) ?? section.chapters[0];
  return { sectionId: section.id, chapterId: chapter?.id ?? 'sign-in' };
}
