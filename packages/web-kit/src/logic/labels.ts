/**
 * Turns a control's `labels` input into a full set: what the screen passes
 * over the control's own text in the current language.
 */
export function withDefaults<L extends Record<string, string>>(defaults: () => L): (given: Partial<L> | undefined) => L {
  return (given) => ({ ...defaults(), ...given });
}
