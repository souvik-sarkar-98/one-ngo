import { test } from '@playwright/test';

/**
 * Manual-plan cases this suite does not run.
 * The reason says what is missing: an operator, a mailbox, a published feature, or a disposable organisation.
 */
const held: [id: string, reason: string][] = [
  ['MT-OP-01', 'Operator sign-in needs the identity provider and a fresh multi-factor check. No operator account is loaded.'],
  ['MT-OP-05', 'Onboard needs a signed-in operator. No operator account is loaded.'],
  ['MT-OP-07', 'Provision follows a validated onboard request. No operator account is loaded.'],
  ['MT-OP-08', 'Find after provision needs a signed-in operator. No operator account is loaded.'],
  ['MT-AUTH-01', 'Asha already has a password. The invitation link is not in this environment.'],
  ['MT-AUTH-09 suspended organisation', 'Suspending an organisation is MT-LIFE-01 and needs an operator multi-factor check.'],
  ['MT-ADM-03', 'Organisation identity confirmation is still a manual pass on the seeded Riverbank setup.'],
  ['MT-PPL-07', 'Suspending a signed-in member on two devices changes a shared persona. Left for a disposable member.'],
  ['MT-REC-16', 'The Donations workflow has no approval step, so there is no stale approval to decide.'],
  ['MT-IN-02', 'The Donations workflow has no approval step, so Inbox has nothing waiting from this module.'],
  ['MT-BLD-02', 'Publishing and restoring a list view is still a manual Builder pass.'],
  ['MT-LIFE-01', 'Suspend needs an operator and a fresh multi-factor check.'],
  ['MT-LIFE-02', 'Member sign-in after suspend follows MT-LIFE-01.'],
  ['MT-LIFE-09', 'Close needs an operator multi-factor check, and it must run on a disposable organisation.'],
  ['MT-NAV-08', 'Pin to everyone writes a Builder draft. This pass does not publish or discard drafts.'],
  ['MT-NAV-11', 'A new person\'s first language needs an invitation email.'],
  ['MT-NAV-12', 'Offline save needs the network to drop and return during an edit.'],
  ['MT-NAV-13', 'The new-version prompt is not offered by this dev server.'],
  ['MT-NAV-14', 'The browser install prompt is not part of this run.'],
  ['MT-PPL-04', 'Resending an invitation needs a mailbox the test can read.'],
  ['MT-PPL-05', 'Suspending a person and then inviting them needs a mailbox.'],
  ['MT-PPL-08', 'Reactivation follows a suspension, which signs the person out on every device.'],
  ['MT-ACC-01', 'Riverbank has no profile field a member is allowed to edit.'],
  ['MT-ACC-03', 'No loaded member has an empty profile.'],
  ['MT-CON-01', 'A reminder with no connector is DEF-06 and needs a mailbox to show whether anything was sent.'],
  ['MT-CON-02', 'No SMS or webhook connector is configured.'],
  ['MT-CON-03', 'Retry needs a failed delivery.'],
  ['MT-KEY-02', 'The per-minute limit needs a clock the test can move.'],
  ['MT-JOB-02', 'Cancelling an import needs a file large enough to still be running.'],
  ['MT-REC-02', 'The type search appears only when more than eight record types are published. Donations publishes two.'],
  ['MT-REC-10', 'Donors and Donations have no file field.'],
  ['MT-REC-11', 'Donors and Donations have no location field.'],
  ['MT-REC-12', 'Donors and Donations have no signature field.'],
  ['MT-REC-13', 'Donors and Donations have no rich text field.'],
  ['MT-REC-15', 'No published step needs approval.'],
  ['MT-REC-19', 'Donors and Donations are not restricted, so Share is not offered.'],
  ['MT-REC-20', 'Share end dates need a restricted record type.'],
  ['MT-REC-21', 'Removing a share needs a restricted record type.'],
  ['MT-REC-23', 'Updating a row on import follows the create import and needs a second file.'],
  ['MT-REC-25', 'A background import with automations on and off needs a mailbox notification.'],
  ['MT-REC-26', 'Cancelling an import needs a run that is still going.'],
  ['MT-REC-29', 'Stop before the last row needs a bulk job large enough to still be running.'],
  ['MT-IN-01', 'No published step needs approval, so Inbox has no number to check.'],
  ['MT-IN-03', 'No published step needs approval.'],
  ['MT-IN-04', 'No published step needs approval.'],
  ['MT-IN-05', 'The seeded organisation has no notifications to mark read.'],
  ['MT-IN-06', 'No finished import, export, or bulk job has a notification in this run.'],
  ['MT-DON-14', 'Proving a reminder was not sent needs a mailbox. DEF-06 says OneNGO email sends it anyway.'],
];

for (const [id, reason] of held) {
  test(id, async () => {
    test.skip(true, reason);
  });
}
