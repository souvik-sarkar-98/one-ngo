# PWA plan: web, Android and iOS

Status: proposed. Covers how OneNGO works as an installed progressive web app (PWA) on desktop web, Android, and iPhone or iPad, and the next three steps: push notifications, offline capture, and optional store listing.

## 1. What already exists

- **Install.** Each organisation gets its own manifest at `/api/auth/organisations/:code/manifest.webmanifest`, with `id` set to `/o/<code>/`, `start_url` set to `/o/<code>/sign-in`, and organisation icons in the required sizes (192, 512, maskable 512, and apple-touch 180). The install button appears on Android and desktop. On iPhone and iPad, the app shows the Share, then Add to Home Screen steps (`apps/onengo/web/src/app/pwa/install.ts`, `install-steps.ts`).
- **Service worker.** Angular's `ngsw` prefetches the app shell and loads lazy chunks as they are needed. It does not cache `/api`. The server sends `index.html`, `ngsw-worker.js`, `ngsw.json` and the manifest as no-cache, and hashed assets with a long cache.
- **Updates.** The update prompt (`update-prompt.ts`) appears when a new version is ready.
- **Offline.** The offline banner (`offline-banner.ts`) says the app is offline. What is on screen stays visible. Saves are blocked, and nothing is queued.
- **Known defect.** DEF-12 in `docs/testing/defect-report.md`: a save attempted offline is not retried when the connection returns.

## 2. Phase 1: make the three platforms behave the same

1. **Fix DEF-12.** When the connection returns, retry the pending save once. Send the record's version so the server rejects the save if someone else changed the record. Clear the "Cannot reach the server" message when the save succeeds.
2. **Sign-in inside the installed app.** On iOS, a Home Screen app keeps its own cookies and storage, separate from Safari. Confirm it opens on `/o/<code>/sign-in`, and that a person stays signed in for a sensible period, so field staff are not asked to sign in every day.
3. **Several organisations on one device.** Each organisation installs as its own app, but all of them share one origin and one service worker (`scope: '/'`). Check that the last-used organisation, the sign-in state, and the update prompt never mix between organisations.
4. **Test matrix.** Run install, update, offline and reload checks on:
   - Chrome on Android, on a low-end phone
   - Safari on iPhone, installed to the Home Screen
   - Chrome or Edge on desktop
   - Firefox on desktop, which has no install button and works as a website

## 3. Phase 2: Web Push, without Firebase

Web Push is the browser standard. Each browser delivers it through its own push service (Google for Chrome and Edge, Mozilla for Firefox, Apple for Safari). OneNGO does not need Firebase or a third-party push vendor.

1. **Server**
   - VAPID keys per installation, stored with the other secrets.
   - A `push_subscription` table: `tenant_id`, `user_id`, `endpoint`, `p256dh`, `auth`, `created_at`, `last_success_at`.
   - Routes to add and remove a subscription.
   - A new `push` notify channel and an outbox event, `notification.push`, sent with the `web-push` package from the public npm registry.
   - A 404 or 410 response from the push service deletes that subscription. Other failures retry in the same way as email.
2. **Content.** A short subject, a body cut to fit, and the in-app link. Keep protected fields masked, as today. Leave donor names and amounts out of push text by default, because anyone holding the phone can read the lock screen.
3. **Client**
   - A "Turn on notifications" switch in My profile. The browser shows its permission prompt only after the person clicks.
   - Use `SwPush` from Angular's service worker. A notification click opens the organisation's `/o/<code>/…` route.
   - On iOS, show the switch only inside the installed app, and explain why when it is opened in Safari.
4. **Channel defaults.** In-app and email stay the defaults. Push is added for approvals, record shares and finished jobs. The inbox row is always the record of the message.

Limits to design for:

- The site must be served over HTTPS, or from localhost during development.
- The person must have installed the app on iOS (iOS 16.4 or later) before push works there.
- A push payload is about 4 KB. Send a short title, body and link, and let the inbox hold the rest.
- Angular's service worker runs only in production builds, so push must be tested against a production build.
- Push delivery is best effort. The browser may delay or drop a message, and the push service does not report whether it was displayed.

## 4. Phase 3: offline capture

This is the largest piece. Decisions are needed before any code is written.

1. **Scope.** Opt in per form. Recommended first targets are new records on field forms, such as volunteer hours and beneficiary visits. Editing existing records offline and running approvals offline stay out of scope at first, because they conflict with other changes.
2. **On the device**
   - Store the published definitions a form needs in IndexedDB.
   - Queue unsent records in IndexedDB. Each record gets a client-generated id, so a resend creates no duplicate.
   - Hold file attachments until the device is back online.
3. **Sync**
   - Send queued records when the device comes back online, and whenever the app opens. Safari and Firefox have no Background Sync, so the app cannot rely on it.
   - Show "3 waiting to send" and any failures in the shell.
4. **Server.** Accept a client id on create. A repeated id is the same request, not a new record. If the record type changed since the definitions were cached, reject the record with a clear reason and keep it on the device so it can be corrected.
5. **Storage loss.** Browsers may clear stored data, especially on iOS. Request persistent storage where the browser supports it. Do not let a person sign out while records are still waiting to send.

## 5. Phase 4: store listing (optional, later)

- **Android.** A Trusted Web Activity (for example, built with Bubblewrap) can list the same PWA on Google Play without rewriting it.
- **iOS.** The App Store does not accept a plain PWA. A listing there needs a native wrapper and Apple review. The product brief excludes a native app from the first delivery.
- **Push in a store app.** FCM applies to an Android store app only, and belongs in this phase, not before it.

## 6. Decisions needed

- Which forms work offline first.
- Whether push text may ever contain names or amounts.
- How long an installed app stays signed in.
- Whether a Google Play listing is wanted.

## 7. Sources in this repo

- `apps/onengo/web/public/manifest.webmanifest`
- `apps/onengo/web/src/app/pwa/` (install, install-steps, update-prompt, offline-banner, connectivity, register-worker)
- `apps/onengo/web/ngsw-config.json`
- `apps/onengo/server/src/http/plugins/static.ts` (no-cache rules)
- `apps/onengo/server/src/http/plugins/organisation.ts` (manifest and icon routes)
- `packages/platform/src/application/organisations/install-manifest.ts`
- `docs/plans/ngo-release-1-build-blocks.md` (B44, Installable app)
- `docs/product-briefs/ngo-management-platform.md` (offline, push, native app scope)
- `docs/architecture/ngo-platform-architecture.md` (Web Push planned, not built)
