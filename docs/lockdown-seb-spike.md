# Lockdown via Safe Exam Browser: Phase 0 spike

**Status:** research done, hands-on tests pending. Sections 1–3 are verified against primary sources and cited. Section 5 lists the tests that need the test Mac. The recommendation in section 4 is provisional until those results are in, and **Phase 1 does not start until this doc is reviewed.**

**Goal (recap).** A teacher picks a Google Form and starts a lockdown. Each targeted student's MacBook opens the Form in stock Safe Exam Browser (SEB) under Apple's Automatic Assessment Configuration (AAC). When the student submits, or the teacher ends the session, the Mac returns to normal. ClassGuard generates the SEB config, launches SEB from the Chrome extension, and tracks session state. It never touches answers or records screens.

## Sources

Citations use these short names.

| Short name | Source |
|---|---|
| **SM** | seb-mac source, `main` at [`1f353e5d`](https://github.com/SafeExamBrowser/seb-mac/tree/1f353e5d7793cdabc69d826500c41d8517b588c8) (2026-09-28). The latest release, **3.7.1**, is tag `a1e3f786`; places where `main` differs are called out. |
| **DEV-CK** | https://safeexambrowser.org/developer/seb-config-key.html |
| **DEV-FF** | https://safeexambrowser.org/developer/seb-file-format.html |
| **DEV-INT** | https://safeexambrowser.org/developer/seb-integration.html |
| **MANUAL** | https://safeexambrowser.org/macosx/mac_usermanual_en.html |
| **RELNOTES** | https://safeexambrowser.org/macosx/mac_release_notes_en.html |
| **DL** | https://safeexambrowser.org/download_en.html |
| **APPLE-AAC** | https://developer.apple.com/documentation/automaticassessmentconfiguration |
| **CHROMIUM** | chromium/src at `979281823a50` |
| **CHROMIUM-2** | chromium/src at [`5a1f0ec9`](https://github.com/chromium/chromium/tree/5a1f0ec90b18293353efc06314154fbc57f02d69) (2026-09-29), used for §1.10 |
| **FORMS-LOCKED** | https://support.google.com/docs/answer/7634943 |
| **FORMS-API** | Google Forms API v1 discovery document, https://forms.googleapis.com/$discovery/rest?version=v1 (fetched 2026-09-29) |

---

## 1. Verified SEB facts

### 1.1 Version, platform, license

**Version and platform**
- The latest release is **SEB 3.7.1 for macOS** (build 159F8), published 2026-09-09. The download is a DMG from GitHub releases (DL). The Mac App Store version is historical (RELNOTES 1.5.x).
- Supported: "macOS 27, 26, 15, 14, 13, 12" (DL).
- On **macOS 26.6 or later, use SEB 3.7.1 or later only**, because of Apple code-signing certificate changes (DL).

**License**
- MPL 2.0 since 3.7 (RELNOTES 3.7; source headers, e.g. SM `Classes/BrowserComponents/SEBWebView.h#L13-16`).
- The binary security modules are proprietary and not in the repo (SM `README.md`).
- Using the stock signed binary satisfies both constraints: we don't modify or redistribute SEB, and we stay on the official AAC-entitled build.

### 1.2 Config file format

**Prefixes and layers**
- The prefixes are `plnd` (plain), `pswd` / `pwcc` (password), and `pkhs` / `phsk` (public key) (DEV-FF).
- SEB itself writes unencrypted exam configs as `gzip("plnd" + gzip(xml))` (SM `Classes/ConfigFiles/SEBConfigFileManager.m#L1390-1410`).

**What the macOS loader also accepts**
- **Raw XML plist**: a `<?xm` prefix is used as-is (L256-262).
- **The outer gzip is optional** (L165-174).
- **The DEV-FF docs are incomplete here:** they don't mention the inner gunzip after `plnd`, but the code performs it (L282-284). Never emit `plnd` followed by uncompressed XML.
- DEV-INT lists "plain text (unencrypted) SEB files" as a valid integration level, provided access is protected server-side and the Config Key is used.

**`sebConfigPurpose`**
- 0 = starting an exam (the default); 1 = configuring the client; 2 = managed configuration (SM `Classes/Global/Constants.h#L419-425`).
- Purpose 0 keeps the settings in memory for that session only, so nothing persists on the Mac (SEBConfigFileManager.m L764-778). **We always use purpose 0.**
- In 3.7.1, a malformed `hashedQuitPassword` / `hashedAdminPassword` causes the load to fail (L938-948).

### 1.3 `seb://` / `sebs://` links

**How SEB handles the link**
- `sebs://host/path` is fetched as `https://host/path`, and `seb://` as `http://` (SM `Classes/Categories/NSURL+SEBURL.m#L97-127`).
- The direct download path follows redirects and **does not check Content-Type** (SM `Classes/BrowserComponents/SEBBrowserController.m#L958-1021`).
- The WebView fallback path accepts `application/seb`, `text/xml`, or a `.seb` extension (SM `SEBAbstractWebView.m#L950-953`).
- DEV-INT: the link "can also be an indirect link similar to mylms.com/file.php?id=34".

**Special forms of the link**
- **Config inside the link.** `sebs://application/seb;base64,<config>` is rewritten to a `data:` URL (NSURL+SEBURL.m), so no hosting is needed. The spike uses this.
- **Per-student token.** A second query string after an extra `?`, e.g. `sebs://host/x.seb??token=…`, is stripped from the download URL (SEBBrowserController.m L500-524). With `startURLAppendQueryParameter` = true, SEB appends it to the start URL (SM `SEBOSXBrowserController.m#L279-286`; MANUAL "Query String Parameter").

**Already running, or failing to load**
- If SEB is already in a secure session, a new link is refused unless `examSessionReconfigureAllow` is on and the link matches `examSessionReconfigureConfigURL` (SEBBrowserController.m L700-725).
- If SEB was *launched by* the link and the config fails to load, SEB quits (SEBOSXBrowserController.m L900-910).
- **HTTP error pages:** in 3.7.1 an HTTP 4xx/5xx body falls through to the parser; the explicit "Downloading Settings Failed" error exists only on `main`. So a server's error page must never look like a config.

### 1.4 Settings we will use

All defaults are from SM `Classes/ConfigFiles/SEBSettings.m`.

| Key | Value we set | Default | Why / source |
|---|---|---|---|
| `sebConfigPurpose` | 0 | 0 | exam session, nothing persisted (Constants.h L419-425) |
| `startURL` | Form or gate page | | |
| **`lockdownModePolicy`** | **2** (enforce AAC) | 0 (automatic, AAC when possible) | **This is the AAC key.** `enableMacOSAAC` was **removed** in 3.7 (SEBSettings.m L1309 `removedSEBSettings`; RELNOTES 3.7). The MANUAL still describes the old checkbox and is out of date. |
| `browserWindowWebView` | 3 (force modern WKWebView) | 2 | Constants.h L101-104 |
| `sendBrowserExamKey` | false | false | headers need the deprecated classic WebView (see 1.5) |
| `URLFilterEnable` | true | false | rules: `{active, regex, expression, action}`; action 1 = allow, 0 = block; unmatched = blocked; start URL auto-allowed; `*` wildcards (SEBSettings.m L1229-1234, Constants.h L513-516, MANUAL) |
| `examSessionClearCookiesOnStart` / `…OnEnd` | true | true | fresh sign-in each session, nothing left behind |
| `allowBrowsingBackForward` | false | false | |
| `browserWindowAllowReload` | (test 4 decides) | true | |
| `quitURL` | our finish/quit URL | "" | see 1.7 |
| `quitURLConfirm` | false | true | quit immediately |
| `hashedQuitPassword` | per-session SHA-256 | "" | lowercase hex SHA-256 of the NFC UTF-8 password (SM `Classes/Cryptography/SEBKeychainManager.m#L209-227`); non-empty makes it a "secure session" |
| `detectAccessibilityApps` | false, or pre-grant FDA via MDM | true | true prompts students for Full Disk Access (RELNOTES 3.7 / 3.7.1) |
| `allowOpenAndSavePanel` | false | false | Forms file-upload questions would need this under AAC (RELNOTES 3.7) |

User-agent keys:
- `browserUserAgent` is a *suffix*.
- `browserUserAgentMac` = 1 plus `browserUserAgentMacCustom` replaces the base string.
- SEB **always** appends `SEB/<version> …` tokens (SEBBrowserController.m L378-409), so SEB can never pass as plain Safari.

### 1.5 Config Key / Browser Exam Key

**Headers**
- The header names are `X-SafeExamBrowser-ConfigKeyHash` and `X-SafeExamBrowser-RequestHash` (SM `Constants.h#L734-735`).
- Each value is `sha256_hex(absolute URL without #fragment + lowercase hex key)` (SEBBrowserController.m L544-556, L617-670; DEV-CK "URL first, then Config Key").

**Config Key derivation** (DEV-CK; SM `SEBCryptor.m#L390-443`)
- SHA-256 of the "SEB-JSON" serialization of the config.
- Keys are sorted case-insensitively at every level (including inside arrays), with no whitespace and **no escaping**.
- `originatorVersion` is dropped and empty dicts are removed.
- `<data>` becomes Base64 and `<date>` becomes ISO 8601.
- Keys absent from the file must equal their defaults.
- Floats use `%.15g`; **ClassGuard emits no `<real>` values**.
- SEB logs "JSON for Config Key:" at Verbose level, which lets us check our server-side computation.

**Headers only exist in the old engine.** DEV-CK: WKWebView "doesn't support sending the Config Key (CK) and Browser Exam Key (BEK) in HTTP headers". DL (3.7.1): the classic WebView is **deprecated**. We therefore verify through the **JavaScript API**:
- `window.SafeExamBrowser.security.configKey` / `.browserExamKey` hold the per-URL hashes for the frame's own URL. They are injected into every frame (SM `SEBAbstractModernWebView.swift#L72-88`, L768-797).
- `updateKeys(callback)` must be given a **named global function**; SEB evaluates `name + "();"` (L80-84, L136-160).
- `sendBrowserExamKey` is not needed for the JS API (DEV-CK).

**What the API can and can't prove**
- A ClassGuard page can confirm it is running inside SEB with *our* config: the page reports the hash and the server compares it with its own computation.
- The page can't prove anything about Google's pages, but it doesn't need to.

**Open doc/code discrepancy.** DEV-CK says `URLFilterEnableContentFilter` forces the classic WebView. The current code implements the content filter in WKWebView (`SEBAbstractModernWebView.swift` L348-378). The spike leaves the content filter off until test 2 settles it.

### 1.6 AAC on macOS

**When SEB uses it**
- AAC has been the **default lockdown mode since 3.7** (RELNOTES 3.7).
- It is used unconditionally on **macOS ≥ 12.1**.
- SEB falls back to the classic kiosk if any of these are enabled: screen capture, window capture, screen sharing, or screen proctoring (Constants.h L288-323). We enable none of them.

**What Apple says an assessment session blocks** (APPLE-AAC, macOS 10.15.4+)
- The Dock, the app menu bar, Mission Control, Notification Center, other Spaces, and other apps.
- Screen recording and capture, and Siri.
- Media playback is stopped and Handoff is off.
- **Only the assessment app has network access.** So the ClassGuard Chrome extension goes offline during the session.
- The pasteboard is cleared at start and end.
- Dictation (`allowsDictation`, macOS 27) and screenshots (`allowsScreenshots`, macOS 26.1) default to off. SEB sets only per-app participant configuration (SM `Classes/SystemManager/AssessmentConfigurationManager.swift#L102-123`).

**Force quit**
- "An assessment session disables force quit by default … does not remove the Force Quit item from the Apple menu" (APPLE-AAC, `allowsForceQuitKeyboardShortcuts`, macOS 27).
- Only one AAC session can run system-wide, and a deallocated session ends automatically (APPLE-AAC `AEAssessmentSession`).

**Known limits:** no dictionary lookup, no background video conferencing, and no optional screen sharing, Siri or dictation (MANUAL; RELNOTES 2.3).

### 1.7 Quitting

**Quit URL**
- `quitURL` must match exactly after both URLs are trimmed of leading and trailing `/`. It is **not a prefix match**, and query strings must match too (SM `SEBAbstractWebView.m#L59`, L737-747; SEBBrowserController.m L577-587).
- In the modern WebView the navigation is **cancelled**, so the server never sees a request to the quit URL itself.
- The quit URL works "regardless of other quit settings … the Quit password is ignored" (MANUAL; SM `SEBController.m#L9097-9148`).

**Redirects:** DEV-INT says you can "invoke a redirect to the Quit URL from your server". That makes a **ClassGuard finish endpoint that records "submitted" and then 302s to the quit URL** the natural pattern. Test 4 checks that the 302 triggers the quit in WKWebView.

**Force-quit and crashes**
- With a quit password set, SEB remembers a running exam. If SEB crashes, is force-quit, or the Mac reboots, relaunching the same config shows a red **"Re-Opening Locked Exam!"** screen that only the quit password clears (SEBController.m L1318-1330, L7030-7044; SM `SEBLockedViewController.m#L104-118`; RELNOTES 2.1.3).
- Without a quit password there is no such lock.

### 1.8 Google sign-in, Forms, iframes

**Sign-in inside SEB is undocumented and must be tested**
- Google "might stop sign-ins from browsers that … are embedded in a different application" (https://support.google.com/accounts/answer/7675428).
- Google blocks OAuth from embedded webviews and lists macOS WKWebView (https://developers.googleblog.com/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/). That post covers the OAuth endpoint, not the normal accounts.google.com web sign-in.
- There is no official SEB statement on Google sign-in. The SEB developers call Google Forms "out of scope of our support" (https://github.com/SafeExamBrowser/seb-mac/issues/64). Google Sheets is known to break in the modern engine (https://github.com/SafeExamBrowser/seb-mac/issues/272).

**Iframes look unworkable for sign-in**
- `accounts.google.com` sign-in pages return `X-Frame-Options: DENY` (observed 2026-09-28), so **sign-in can't happen inside an iframe**.
- WKWebView apps have ITP on and cross-site cookies blocked (https://webkit.org/blog/10882/app-bound-domains/, https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/).
- SEB's developers declined to add a third-party cookie setting (https://github.com/SafeExamBrowser/seb-mac/issues/67, https://github.com/SafeExamBrowser/seb-mac/issues/135).
- **Prediction:** a sign-in-required Form embedded in a ClassGuard page won't see the Google session. Test 5 checks this.

**Google Forms locked mode**
- Officially it requires managed Chromebooks on ChromeOS 75+ (https://support.google.com/docs/answer/7634943).
- Google doesn't document the behaviour on macOS. A community thread quotes "Locked mode is on. Only respondents signed in to managed Chromebooks can open this quiz." (https://support.google.com/docs/thread/180626314).
- Treat it as **blocking the Form on Macs** until test 6 confirms. This is why teachers must leave it off.

### 1.9 Launching from Chrome

**`AutoLaunchProtocolsFromOrigins`**
- Chrome 85+. Format: `[{"protocol":"sebs","allowed_origins":[…]}]`, with origin patterns in URLBlocklist format and no path (https://chromeenterprise.google/policies/#AutoLaunchProtocolsFromOrigins).
- It matches the navigation's **initiator origin** (CHROMIUM `chrome/browser/external_protocol/external_protocol_handler.cc#L297-328`).
- An extension's `chrome.tabs.update` sets the initiator to `chrome-extension://<id>` (CHROMIUM `chrome/browser/extensions/api/tabs/tabs_api.cc#L2966-2983`).
- The URLBlocklist format doesn't list `chrome-extension` among its schemes, and custom schemes only allow `scheme:*` / `scheme://*` (https://support.google.com/chrome/a?p=url_blocklist_filter_format). So a per-ID extension origin is **probably not expressible**.

**`URLAllowlist` is the more direct lever**
- If the target URL is in URLAllowlist, Chrome launches the external handler **without the prompt, whoever initiated it** (CHROMIUM `chrome/browser/chrome_content_browser_client.cc`, `LaunchURL` → `LaunchUrlWithoutSecurityCheck`).
- The policy text: "also allows enabling the automatic invocation … of external application registered as protocol handlers for the listed protocols" (Chrome 86+).
- **Candidate: URLAllowlist `sebs://*`.** It also skips Chrome's anti-flood rule, which otherwise blocks a second launch that lacks a user gesture (external_protocol_handler.cc L529-563).

### 1.10 ChromeOS: what an extension can and can't lock

SEB doesn't exist for ChromeOS, so Chromebooks need a different lock. This section records what's possible.

**The hard lock is reserved for Google's own extensions**
- ChromeOS has a `locked-fullscreen` window state that "cannot be exited by user action and is available only to allowlisted extensions on Chrome OS" (CHROMIUM-2 `chrome/common/extensions/api/windows.json#L60-62`).
- It is gated by the `lockWindowFullscreenPrivate` permission. The allowlist holds only hashed IDs for Chromium's API-test extension, **Assessment Assistant** (the engine behind Forms locked mode), and **Share to Classroom** (CHROMIUM-2 `chrome/common/extensions/api/_permission_features.json#L559-573`).
- A third-party extension like ClassGuard's can't be added to that list. **ClassGuard can't hard-lock a Chromebook.**

**Google Forms locked mode is the only hard lock available** (FORMS-LOCKED)
- It needs Workspace for Education, a school-managed Chromebook per student, and ChromeOS 75+.
- Students "can't use other apps", and "some extensions and keyboard shortcuts are disabled". Google doesn't say which extensions, so **whether ClassGuard's force-installed extension keeps running during locked mode is unknown** (test C3).
- The teacher is emailed when a student exits the quiz or opens another tab.
- It is a per-Form setting ("Chromebook settings → Locked mode"). **The Forms API doesn't expose it**: `FormSettings` has only `emailCollectionType` and `quizSettings.isQuiz` (FORMS-API). ClassGuard therefore can't turn it on, and can't even read whether a Form has it on.
- It is reported to block the Form on non-Chromebooks (§1.8; test 6 confirms on a Mac).

**What ClassGuard's extension can do** (today's `chrome` soft lock, `chrome-extension/src/lib/lockdownGuard.js`)
- Today it allows only the Form's URLs (DNR), collapses the student to one tab, closes new tabs and windows, and logs `new_tab`, `tab_switch`, `new_window` and `focus_loss`.
- It **can't** stop the student from leaving Chrome for ChromeOS apps (Files, Android apps, the launcher, the calculator). It can only detect the focus loss and report it.
- It **doesn't use fullscreen today**. The public `fullscreen` window state is available to any extension (CHROMIUM-2 `windows.json#L57-58`), but the student can exit it. The extension can watch `chrome.windows.onBoundsChanged`, re-apply fullscreen, and log a `fullscreen_exit` event. Whether re-applying works without a user gesture on ChromeOS needs checking (test C2).
- **Respondus LockDown Browser for Chromebook uses the same approach.** Its current Chrome extension (Respondus OEM build 0.4.91 as distributed by Otus, `eckdmemhmpcbbbpnlkokljecnkloamnl`, and MasteryConnect, `nkkighcdodpjcdenompholalclpaobff`; downloaded from the Chrome Web Store 2026-09-29) has **no** `lockWindowFullscreenPrivate` permission. Its background script:
  - puts the exam window in the public `fullscreen` state, re-applies it from `windows.onBoundsChanged` plus a polling timer, and refocuses the exam window from `windows.onFocusChanged` plus a 1 s check, showing a "focus lost" page;
  - closes extra tabs, checks for other extensions via `chrome.management`, detects VMs, blanks the wallpaper, and handles tablet-mode rotation via `chrome.system.display`;
  - only engages on `getPlatformInfo().os === 'cros'`.

  So the market-leading Chromebook lockdown is also a soft lock built on public APIs, and re-applying fullscreen without a user gesture evidently works in production (test C2 still confirms it on our fleet). Respondus's 2019 admin guide describes an older **kiosk app** launched from the login screen; Respondus-based guides now say to switch to the extension.
- Admin console policies (e.g. no Android apps, no screenshots) would tighten this further, but they apply to the student OU all day, not just during a test. They are the district's call, outside ClassGuard.

**Agreed Chromebook plan (2026-09-29)**
1. **Default: soft lock plus forced fullscreen and focus snap-back.** Chromebook students get today's `chrome` lock type, plus:
   - **Fullscreen enforcement:** re-apply fullscreen from `windows.onBoundsChanged`, with a polling timer as a backstop, and log a `fullscreen_exit` event.
   - **Focus snap-back** (as Respondus does): when `windows.onFocusChanged` reports another window or `WINDOW_ID_NONE` (Chrome lost focus to a ChromeOS app), refocus the exam window, with a ~1 s check as a backstop. Log `focus_loss` as today, now with how long focus was away.

   The dashboard labels them "Chromebook: soft lock".
2. **Optional: Google locked mode.** When starting a session, a teacher can also enter a **second Form URL for Chromebooks**: a copy of the Form with locked mode on.
   - Chromebook students are sent to the locked copy, and Mac and Windows students to the unlocked original in SEB.
   - ClassGuard can't verify the copy really has locked mode on (FORMS-API), so the UI says so.
   - The cost is that responses land in two Forms. The teacher UI must say this plainly.
   - If test C3 shows locked mode disables the ClassGuard extension, those students drop out of ClassGuard's live log for the duration, and Google's email notifications are the teacher's only signal.
3. **Routing.** The policy carries both URLs and the extension picks by `chrome.runtime.getPlatformInfo().os`. The server doesn't need to know a device's OS up front. The extension reports its OS when the lock engages, so the dashboard can label each student.

---

## 2. How this fits the existing ClassGuard architecture

This extends the existing **Lockdown Test** feature instead of adding a parallel one.

**What exists** (migration `059_lockdown_browser.sql`, `routes/lockdown.js`, `chrome-extension/src/lib/lockdownGuard.js`)

**Sessions and state**
- `lockdown_sessions` holds one active session per student: teacher, class, target URL, `ends_at`, status `active | ended | expired`.
- `lockdown_events` is a per-student event log that streams live to the class dashboard (`lockdown:event` → `class:<id>` room).

**Enforcement**
- Lockdown is a **policy mode** (`resolvePolicy()` step 0) that outranks lesson, penalty box and normal policy.
- It reaches the extension via `policy:updated` and `syncPolicy()`. There is no separate command channel.
- The extension then applies DNR rules that allow only the Form's URL prefix, closes other tabs, and logs escape attempts.

**Expiry and UI**
- `expireLockdownSessions()` in the scheduler ends timed sessions.
- The teacher UI already has a Form-URL input, a duration field, per-student badges, End buttons, and a district-wide `/lockdown` page.

**What SEB adds** (Phases 1–4, pending this review)
- **Data model.**
  - `lockdown_sessions.lock_type`: `chrome` (today's soft lock) | `seb`.
  - A per-student SEB state: `pending → launched → in_progress → submitted | ended_by_teacher | abandoned`.
  - A per-session config token (unguessable, expiring) and quit password hash.
  - New event types, e.g. `seb_launched`, `seb_not_launched`, `seb_heartbeat_lost`.
- **Extension, on Macs.**
  - `chrome.runtime.getPlatformInfo().os === 'mac'` → open the session's `sebs://` link.
  - Keep blocking the Form URL in regular Chrome using the same DNR lockdown-mode rules, inverted. This needs a new rule outside the mode branch, because today's URL rules only apply in `standard` mode.
  - If SEB never reports in within N seconds, report `seb_not_launched`.
  - The extension has **no platform detection today**; this adds it.
- **Extension, on Chromebooks** (`os === 'cros'`). Today's `chrome` lock type plus forced fullscreen, with an optional teacher-supplied locked-mode copy of the Form. See the agreed plan in §1.10.
- **Liveness during AAC.** The ClassGuard extension **loses network access**: AAC allows network only for SEB (APPLE-AAC). So an extension heartbeat can't be the signal, and the page inside SEB has to report.
- **DNS doesn't help.** The DNS engine sees hostnames only and ignores `lockdown` mode, so it plays no part.

## 3. Candidate layouts

| | **Direct** (start URL = the Form) | **Wrapper** (ClassGuard page, Form in an iframe) | **Gate + direct** (start URL = ClassGuard gate page, which navigates top-level to the Form) |
|---|---|---|---|
| Google sign-in | top-level, so it has the best chance (test 1) | **predicted to fail**: sign-in is `X-Frame-Options: DENY`, and third-party cookies are blocked under ITP (test 5) | top-level, same as Direct |
| Verify "real SEB with our config" | no ClassGuard page, so no | yes, via the JS API on the wrapper | yes, via the JS API on the gate |
| Launch confirmation | none | yes | yes (the gate reports `launched`) |
| Live heartbeat while answering | none | yes, from the wrapper | **none** while on Google's pages |
| Submitted signal | only if the student clicks a link | Finish button | a link in the Form's confirmation message → ClassGuard finish endpoint → 302 to `quitURL` |
| Teacher end → quit | no | at the next heartbeat, the wrapper navigates top-level to `quitURL` | not while on the Form; fallback below |

## 4. Provisional recommendation

The recommendation is **gate + direct**, unless test 5 shows the wrapper works with sign-in-required Forms. In that case the wrapper wins, because it's the only layout with a live heartbeat and a remote quit.

**Launch**
1. The start URL is ClassGuard's gate page: `https://<classguard>/lockdown/seb/<token>`.
2. The gate checks the Config Key through the JS API, records `launched` and then `in_progress`, and navigates top-level to the Form.

**Submitting and quitting**
3. The teacher adds one line to the Form's confirmation message ("Click here to finish"), linking to `https://<classguard>/lockdown/seb/<token>/finish`. ClassGuard records `submitted` and 302s to the session's `quitURL`, and SEB quits (test 4).
4. The session has a per-session quit password. The teacher's dashboard shows it, for unlocking a crashed or rebooted "Re-Opening Locked Exam" Mac, or for ending one student manually.

**Status while answering.** A student stays "in progress" with no live heartbeat while on Google's pages. The dashboard shows "in SEB since hh:mm". A student is flagged "abandoned" if `ends_at` passes, or if the extension comes back online before the finish endpoint was hit, which means SEB exited another way.

**Teacher ends the session**
- Pending students stop launching.
- Running students can't be quit remotely while on Google's pages, since there is no page of ours to redirect.
- Fallback: the teacher tells students to finish, or walks over and enters the quit password.

**To investigate before Phase 2 (not yet verified).** SEB Server is SEB's own server protocol. It may offer a client ping and a remote quit that don't depend on the page. It would be much more work than the gate page.

**Known gap: unmanaged devices (accepted for now, 2026-09-29).**
- Respondus closed this gap through the LMS: the assessment platform itself refused to serve a lockdown test to anything but LockDown Browser. Google Forms can't do that. It serves the Form to any browser.
- On school-owned devices ClassGuard covers it: the extension blocks the Form in regular Chrome during the session, and the gate page's Config Key check confirms real SEB with our config.
- On a device ClassGuard doesn't manage, such as a personal phone, nothing stops a student who has the Form link. DNS filtering can't help, because it sees only `docs.google.com`, not which Form is being opened.
- **Mitigations:**
  - The Form uses **Limit to 1 response** with **verified email**, so a student gets one attempt and it's tied to their account.
  - ClassGuard records who finished through SEB's finish link. The teacher can compare that with the Form's responses: a response from a student ClassGuard never saw finish came from somewhere else.
  - Automating that comparison would need read access to Form responses through the Forms API, which ClassGuard doesn't have today. Possible later work.
- **Decision:** ClassGuard targets districts with managed, school-owned devices, so this gap is accepted and not a Phase 1–4 requirement.

---

## 5. Hands-on tests (test Mac)

### Setup
1. Install **SEB 3.7.1** from DL on a test Mac running a current macOS (≥ 12.1; ideally the fleet's version). Check the DMG's SHA-256 against DL. Record the macOS and SEB versions.
2. Create a **test Google Form** as a test-OU teacher:
   - Settings → Responses: **Collect email addresses: Verified**, and **Limit to 1 response**. These force sign-in.
   - Quizzes → **Locked mode OFF** for tests 1–5.
   - Confirmation message: `Click here to finish: https://<classguard-domain>/seb-quit`.
3. Generate the test configs on any machine with Node 18+:
   ```
   node scripts/seb-spike/make-config.js \
     --form 'https://docs.google.com/forms/d/e/<FORM_ID>/viewform' \
     --origin 'https://<classguard-domain>' \
     --quit-password '<test password>' \
     --out seb-spike-out
   ```
   Each variant gets a `.seb` file (double-click it on the Mac) and a `.link.txt` containing a `sebs://application/seb;base64,…` link that carries the whole config.

   The pages used by variants `0-probe` and `5-wrapper` (`/seb-spike/probe.html`, `/seb-spike/wrapper.html`) ship in `frontend/public/seb-spike/` and are live once this branch is deployed.
4. Turn on SEB's verbose log (SEB → Settings → Security → Logging) so blocked URLs and "JSON for Config Key" get recorded.

### Test 0: probe (JS API)
Open `0-probe.seb`.
- **Pass:** "SafeExamBrowser API: present", non-empty Config Key and Browser Exam Key hashes, and a UA containing `SEB/3.7`.
- Record the CK hash and the verbose log's "JSON for Config Key" line, for the Phase 1 server-side CK check.

### Test 1: Google sign-in inside SEB
- **1a.** Open `1a-signin-nofilter.seb` (no URL filter). Sign in with a test-OU **student** account, answer and submit.
  - **Pass:** sign-in succeeds with no "This browser or app may not be secure", and the submission shows the verified email.
- **1b.** Open `2-direct-aac-filtered.seb` (filter on). Repeat. Note every URL the verbose log shows as blocked. That list becomes the Phase 1 allowlist.
- **1c.** Only if 1a fails: open `1c-signin-safari-ua.seb` (custom Safari base UA; SEB still appends its tokens). Record whether sign-in behaves differently.
- Also note whether the district's Workspace uses a third-party IdP (SAML). If it does, repeat 1a through it.

### Test 2: AAC lockdown
With `2-direct-aac-filtered.seb` running, try each of these and record the result:

| Action | Expected |
|---|---|
| Cmd+Tab | blocked |
| Cmd+Space (Spotlight) | blocked |
| Mission Control (F3 / Ctrl+↑ / trackpad swipe) | blocked |
| Cmd+Shift+3/4/5 screenshot | blocked |
| Open Notes via any route | blocked |
| Notification Center | blocked |
| Dock | hidden |
| Siri / dictation | blocked |
| Copy text into the Form from before the session | pasteboard cleared at start |
| Cmd+Q / Cmd+W | quit password prompt |
| Hot corners, Stage Manager | blocked |

In the verbose log, confirm it's AAC and not the classic kiosk. Also note whether the Form loads fully with the filter on.

### Test 3: launch from Chrome
Use the ClassGuard extension on the test Mac, or any Chrome profile.
- **3a. Typed.** Paste the contents of `2-direct-aac-filtered.link.txt` into the Chrome address bar. Record the prompt ("Open Safe Exam Browser?"), whether SEB launches, and whether the config loads.
- **3b. Extension-initiated.** This is the real path.
  1. Go to `chrome://extensions` → ClassGuard → service worker **Inspect**.
  2. In the console, run `chrome.tabs.update({ url: '<the link>' })`.
  3. Record whether a prompt appears and whether SEB launches.
- **3c. With policy.** In a **test OU** in Google Admin, set **URL allowlist: `sebs://*`**, then repeat 3b. **Pass:** no prompt.
  - If 3c still prompts, add `AutoLaunchProtocolsFromOrigins` = `[{"protocol":"sebs","allowed_origins":["chrome-extension://*"]}]` and record whether Chrome accepts that origin pattern (`chrome://policy` shows errors).
- **3d. Second launch.** Quit SEB, then repeat 3b twice in a row without clicking anything in between. This checks Chrome's anti-flood rule under the policy.
- **3e. Hosted config.** Serve one `.seb` over HTTPS anywhere and open `sebs://<host>/<path>.seb`. This confirms the fetch path, not just the embedded link.

### Test 4: quitting
- **4a. Quit link.** Submit the Form, then click the confirmation-message link. **Pass:** SEB quits immediately and the Mac is back to normal.
  - Google may wrap confirmation-message links through a `https://www.google.com/url?q=…` redirect. Record the exact URL the link opens (verbose log).
  - If it is wrapped, the URL filter must allow `www.google.com/url*`, and the quit must survive that extra redirect.
- **4b. Redirect to the quit URL.** This depends on a Phase 1 endpoint, or run it with any HTTPS URL that 302s to the configured `quitURL`. Does a **302 to `quitURL`** quit SEB? This decides the finish-endpoint design.
- **4c. Force-quit.** During a session, try Cmd+Opt+Esc and the Apple menu → Force Quit. Record whether either works.
- **4d. Reboot.** Hard-reboot the Mac mid-session (hold the power button). After login, reopen the same config and record whether "Re-Opening Locked Exam!" appears and whether the quit password clears it. Also record the Mac's state right after reboot.
- **4e. Reload.** Use Cmd+R on the confirmation page and on a half-filled Form. Record any re-submission or data loss. This decides `browserWindowAllowReload`.

### Test 5: wrapper vs. direct
Open `5-wrapper.seb`.
- **5a.** Does the embedded Form load? Does it ask for sign-in, and can the student complete it inside the iframe? Expected: no.
- **5b.** Repeat with a Form that does **not** require sign-in. Does it load and submit in the iframe?
- **5c.** Does the "Finish" link (top-level navigation to `quitURL`) quit SEB?

### Test 6: Google Forms locked mode on a Mac
Turn **Locked mode ON** for the test Form. Open it:
- in regular Chrome on the Mac;
- in SEB (`1a` config).

Record the exact messages. This becomes the teacher-facing warning text in Phase 4.

### Chromebook tests (test Chromebook)
Use a managed Chromebook signed in as a **test-OU student** whose OU allows developer tools (`DeveloperToolsAvailability`), so the extension's service worker can be inspected.

**C1. Today's soft lock, baseline.** Start a normal ClassGuard Lockdown Test for the test student from ActiveLesson. Then try each of these and record whether it works and whether an event appears in the teacher's live log:
- open the launcher and start Files, the calculator, and an Android app (if the OU allows Android apps);
- Alt+Tab between them and Chrome;
- the screenshot key;
- a new tab, a new window, and closing the test tab.

**C2. Forced fullscreen.** In `chrome://extensions` → ClassGuard → service worker **Inspect**, run:
```js
const [w] = await chrome.windows.getAll({ windowTypes: ['normal'] });
await chrome.windows.update(w.id, { state: 'fullscreen' });
chrome.windows.onBoundsChanged.addListener(async (win) => {
  const cur = await chrome.windows.get(win.id);
  if (cur.state === 'fullscreen') return;
  console.log('exit detected');
  chrome.windows.update(win.id, { state: 'fullscreen' })
    .then(() => console.log('re-applied'), (e) => console.log('failed', e.message));
});
```
Leave fullscreen with the fullscreen key, Esc and a touchpad gesture. **Pass:** "exit detected" then "re-applied", and the window really returns to fullscreen.

**C2b. Focus snap-back.** In the same console, run:
```js
const [w] = await chrome.windows.getAll({ windowTypes: ['normal'] });
chrome.windows.onFocusChanged.addListener((id) => {
  if (id === w.id) return;
  console.log('focus left to', id);
  chrome.windows.update(w.id, { focused: true })
    .then(() => console.log('refocused'), (e) => console.log('failed', e.message));
});
```
Switch away with Alt+Tab, the launcher, the shelf, and by opening Files and an Android app. **Pass:** focus returns to the Chrome window within about a second each time. Record any route where it doesn't (for example, whether an Android app or a system dialog keeps focus).

**C3. Locked mode vs. the ClassGuard extension.** Make a copy of the test Form with **Locked mode ON**. As the test student, open it and start the quiz. While it's locked, check from the teacher's side:
- Does the student's ClassGuard status stay online (live screen thumbnail, activity)?
- Does a ClassGuard Lockdown Test started with the locked copy as its URL still work, or does the soft lock's tab handling interfere with locked mode?
- After exiting, did the teacher get Google's email notification?

**Pass:** the extension keeps working during locked mode. If it doesn't, note exactly what stops. That decides how §1.10 option 2 is presented to teachers.

### Results

| Test | Result | Notes |
|---|---|---|
| 0 probe | | |
| 1a sign-in, no filter | | |
| 1b sign-in, filtered (blocked-URL list) | | |
| 1c custom UA | | |
| 2 AAC checklist | | |
| 3a typed link | | |
| 3b extension link | | |
| 3c URLAllowlist `sebs://*` | | |
| 3d second launch | | |
| 3e hosted `.seb` | | |
| 4a quit link | | |
| 4b 302 to quit URL | | |
| 4c force quit | | |
| 4d reboot | | |
| 4e reload | | |
| 5a wrapper, sign-in form | | |
| 5b wrapper, open form | | |
| 5c wrapper Finish | | |
| 6 locked mode on Mac | | |
| C1 Chromebook soft lock baseline | | |
| C2 forced fullscreen re-apply | | |
| C2b focus snap-back | | |
| C3 locked mode vs. extension | | |

## 6. Decisions needed at review

1. **Layout.** Confirm gate + direct, or wrapper if test 5 passes.
2. **Quit password policy.** One per session, shown to the teacher, or one district-wide unlock password held by IT? A per-session password limits the damage if it leaks.
3. **Full Disk Access.** Pre-grant it to SEB via an MDM PPPC profile (and keep `detectAccessibilityApps` on), or turn detection off?
4. **Fleet facts.**
   - The macOS versions on student MacBooks. Anything below 12.1 changes AAC behaviour.
   - Whether the MDM is Mosyle; ClassGuard already integrates with it.
   - Whether Workspace sign-in goes through a third-party IdP.
5. **Remote quit.** Is the teacher fallback in §4 (no remote quit while a student is on Google's pages) acceptable, or should SEB Server be investigated before Phase 2?

## 7. What's in this commit / left to do

**In this commit:**
- This doc.
- `scripts/seb-spike/make-config.js`, which generates the test configs and links.
- Two static spike pages, `frontend/public/seb-spike/probe.html` and `wrapper.html`. They send no data anywhere. Remove them after the spike.

**Left to do:**
- Run section 5 on the test Mac and fill in the results table.
- Review and decide section 6.
- Then Phase 1: config generation, the gate and finish endpoints, and the server-side Config Key check.
