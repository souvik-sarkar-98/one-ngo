# UI designer handoff — OneNGO audit fixes

## Working location

- Worktree: `C:\Users\ssarkar392\CEResources\integrated\ngo-worktrees\ui-ux-audit`
- Branch: `features/ui-ux-audit`
- App URL after starting `npm run dev`: `http://localhost:4200`
- Audit: [ui-ux-audit-2026-11-01.md](ui-ux-audit-2026-11-01.md)
- Evidence: [evidence/ui-ux-2026-11-01](evidence/ui-ux-2026-11-01)

Do not use the primary checkout for this work. The audit report and evidence are currently uncommitted in this worktree.

## Product decisions already made

1. **Settings remains canonical.** Keep personal account details, language, two-step status, and About under Settings. Update older design/manual documentation that still expects these items directly in More.
2. **Account-only identity remains canonical.** Do not restore the removed member-profile APIs. Replace the broken My profile flow with account details already available from the signed-in session.

## Design objective

Produce implementation-ready interaction and visual guidance for the audit findings, prioritizing safe administration, keyboard accessibility, touch usability, and consistent responsive behavior. Preserve the existing visual language unless a defect requires a change.

## Priority design work

### 1. Theme safety

Design the Theme screen so its editable values, preview, contrast results, and publish state always describe the same draft.

Acceptance criteria:

- Stored/default colours appear in both colour pickers and text inputs.
- Publish is unavailable while loading, unchanged, invalid, or saving.
- Invalid colours identify the exact field.
- Preview and contrast update from the visible draft only.
- Reset clearly distinguishes “restore published values” from “restore product defaults.”

Reference: [theme-black-controls.png](evidence/ui-ux-2026-11-01/theme-black-controls.png)

### 2. Account details

Replace the broken My profile panel with an account-details treatment based on the current account-only backend.

Acceptance criteria:

- Name, email, roles, and two-step state are understandable without implying they are editable.
- The screen explains where an administrator-managed value can be changed.
- No empty modal or generic “Not found” state remains.
- Settings remains the entry point.

Reference: [profile-not-found.png](evidence/ui-ux-2026-11-01/profile-not-found.png)

### 3. Shared modal and validation behavior

Define one interaction model for create, filter, import, account, language, and administration panels.

Acceptance criteria:

- Opening moves focus to the title, close control, or first field.
- Tab and Shift+Tab remain inside.
- Escape closes non-destructive panels.
- Closing restores focus to the trigger.
- Background controls cannot be reached while the modal is open.
- Failed submission focuses the first invalid field and provides an error summary for multiple failures.
- Desktop uses a centred panel; phone uses a bottom sheet up to 92% of viewport height.

### 4. Phone touch targets and spacing

Bring all phone interactions to a minimum 44 × 44 CSS-pixel target without making the interface visually heavy.

Measured failures include account, breadcrumb expander, Back, Close, chips, Sort, Filters, and form footer buttons.

Acceptance criteria:

- Interactive boxes are at least 44 × 44; icons may remain visually smaller.
- Adjacent targets have enough separation to avoid accidental taps.
- Sticky form actions do not cover the last field.
- Bottom navigation and safe-area spacing remain intact.
- No horizontal overflow at 390 × 844.

Reference: [new-donation-mobile.png](evidence/ui-ux-2026-11-01/new-donation-mobile.png)

### 5. Form and action clarity

Provide final copy and states for:

- Singular headings: **Create donor**, **Create donation**.
- Required Add person fields: Email, Name, and at least one Role.
- Processing fee error beside the fee field while retaining a summary.
- New API key role selector with an explicit visible/accessibility label.
- Empty record list with Select hidden or disabled.
- New connector represented by URL state, with Back/reload restoring the panel.

### 6. Layout reordering

Keep the current Up/Down controls if desired, but make context and feedback explicit.

Acceptance criteria:

- Accessible action names include the item, e.g. **Move Records up**.
- The updated position is announced after every move.
- Disabled states explain fixed items where necessary.
- Sidebar and More groups remain visually distinct.

### 7. Localization

Complete the Settings page identity in every supported language.

Acceptance criteria:

- Heading, breadcrumb, browser title, navigation, field labels, notices, and dialog labels switch together.
- English appears only as an intentional fallback for an unpublished organisation string.

Reference: [settings-hindi-mixed.png](evidence/ui-ux-2026-11-01/settings-hindi-mixed.png)

### 8. Audit log readability

Replace raw event keys and UUID-heavy primary text with administrator-friendly summaries.

Acceptance criteria:

- Primary text answers who did what to which item.
- Date/time and area remain scannable.
- Raw IDs and payloads are available only under expandable technical details.
- Unknown events have a safe human-readable fallback.

## Design constraints

- Preserve single-column record panels and forms at every width.
- Preserve desktop side navigation and phone bottom navigation.
- Preserve address-backed state for panels, tabs, filters, sort, layout, and open records.
- Do not redesign Builder editors for phone; phone remains published-settings/read-only.
- Use colour plus text/icon/status, never colour alone.
- Keep the existing system font and local assets.

## Expected designer deliverables

1. Annotated desktop and phone states for Theme, account details, a representative modal/form, Layout, and Audit log.
2. A compact interaction specification covering modal focus, validation focus, keyboard behavior, touch targets, loading, error, empty, and saving states.
3. Final copy for singular create headings, required-role guidance, account details, theme reset/publish states, and audit summaries.
4. Any token or shared-component changes needed for implementation.
5. A list of audit findings that require no visual change and can proceed directly to engineering.

## Engineering plan summary

After design handoff, engineering should implement in this order:

1. Theme safety, account-only Settings, and locale completeness.
2. Shared modal/form accessibility and 44 px touch targets.
3. Connector URL state, form wording/validation, targeted fee error, and empty-list actions.
4. Audit-log summaries and documentation alignment.
5. Focused tests, typecheck/build, then Playwright verification at 1440 × 1000 and 390 × 844.
