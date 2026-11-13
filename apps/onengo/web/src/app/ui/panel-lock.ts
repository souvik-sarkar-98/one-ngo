let openSheets = 0;

/** Marks the page while any sheet is open, as the list toolkit did, so the page behind can stop scrolling. */
export function setSheetOpen(open: boolean): void {
  if (typeof document === 'undefined') return;
  openSheets = open ? openSheets + 1 : Math.max(0, openSheets - 1);
  document.body.classList.toggle('mobile-sheet-open', openSheets > 0);
}
