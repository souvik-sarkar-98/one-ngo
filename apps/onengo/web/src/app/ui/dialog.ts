import { t } from '../core/i18n/i18n';

/** The dialog behaviour (focus, Tab trap, inert page, Escape) lives in the web kit so every app shares it. */
export {
  DialogFocus,
  dialogShade,
  initialFocus,
  inertTargets,
  nextTab,
  swallowBackdropClick,
  syncDialogInert,
  tabbables,
  trapTab,
  type BackdropClick,
} from '@onengo/web-kit';

/**
 * What the button that closes a dialog reads. A workflow step or action carries its own
 * label on the confirm button, so a step called Cancel would put Cancel on both buttons;
 * the close button then reads Back instead.
 */
export function dialogCloseLabel(confirmLabel: string, closeLabel: string): string {
  const same = confirmLabel.trim().toLocaleLowerCase() === closeLabel.trim().toLocaleLowerCase();
  return same ? t('ui.common.back') : closeLabel;
}
