/** One step of a breadcrumb. The current page is the last step and has no link. */
export interface Crumb {
  label: string;
  href?: string;
}

/** A step the app already named. The kit decides which ones appear and which one links. */
export interface TrailStep {
  label: string;
  href?: string;
}

/**
 * The breadcrumb for a directory: the destination, then its group caption,
 * then the page, then whatever was opened from there.
 *
 * A group is left out when the page has the same name. A page whose name
 * begins with the group ("Organisation profile" under Organisation) keeps
 * only the rest ("Profile"). Every step but the last keeps its link.
 */
export function directoryTrail(destination: TrailStep, group: TrailStep | null, rest: readonly TrailStep[]): Crumb[] {
  const page = rest[0];
  const named = page ? { ...page, label: group ? leafLabel(group.label, page.label) : page.label } : null;
  const steps: TrailStep[] = [destination];
  if (group && (!named || group.label !== named.label)) steps.push(group);
  if (named) steps.push(named, ...rest.slice(1));
  return steps.map((step, index) => (index < steps.length - 1 ? linked(step) : { label: step.label }));
}

function leafLabel(group: string, page: string): string {
  const prefix = `${group} `;
  if (page.length <= prefix.length || page.slice(0, prefix.length).toLocaleLowerCase() !== prefix.toLocaleLowerCase()) return page;
  const rest = page.slice(prefix.length);
  return rest.charAt(0).toLocaleUpperCase() + rest.slice(1);
}

function linked(step: TrailStep): Crumb {
  return step.href ? { label: step.label, href: step.href } : { label: step.label };
}
