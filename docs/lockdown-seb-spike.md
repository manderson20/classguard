# Lockdown via Safe Exam Browser: Phase 0 spike

**Status:** research done, hands-on tests pending. Sections 1–3 are verified against primary sources and cited. Section 5 lists the tests that need the test Mac and a test Chromebook. **Section 8 covers SEB for Windows** (research 2026-09-29, with its own tests in §8.5). The recommendation in section 4 is provisional until those results are in, and **Phase 1 does not start until this doc is reviewed.**

**Goal (recap).** A teacher picks a Google Form and starts a lockdown. Each targeted student's MacBook (or Windows laptop, §8) opens the Form in stock Safe Exam Browser (SEB) under Apple's Automatic Assessment Configuration (AAC). When the student submits, or the teacher ends the session, the Mac returns to normal. ClassGuard generates the SEB config, launches SEB from the Chrome extension, and tracks session state. It never touches answers or records screens.

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

**Status while answering.** A student stays "in progress" with no live heartbeat while on Google's pages. The dashboard shows "in SEB since hh:mm". A student is flagged "abandoned" if `ends_at` passes, or if the extension comes back online before the finish endpoint was hit, which means SEB exited another way. **On Windows the extension never goes offline** (§8.2 #2), so there only the `ends_at` rule applies.

**Teacher ends the session**
- Pending students stop launching.
- Running students can't be quit remotely while on Google's pages, since there is no page of ours to redirect.
- Fallback: the teacher tells students to finish, or walks over and enters the quit password.

**To investigate before Phase 2 (not yet verified).** SEB Server is SEB's own server protocol. It may offer a client ping and a remote quit that don't depend on the page. It would be much more work than the gate page.

**Requirement: getting out must be reliable (2026-09-29).**

With Respondus, students sometimes couldn't get out of lockdown after finishing, especially after closing the lid mid-test or after submitting. Every lock type must therefore follow these rules:
- **No dependence on the network or the teacher.** Each lock has a local, offline way out.
- **Finishing releases the student.** Submitting the Form and following the finish step ends the lock, with no teacher action.
- **Sleep and restart are normal events.** Closing the lid, the battery dying or a reboot must leave the device either still correctly locked or cleanly released, never half-locked.

How each platform meets this:

| | Chromebook (soft lock) | Mac / Windows (SEB) |
|---|---|---|
| Finished | The extension watches the lock tab's navigation. When it sees the Form's post-submit confirmation, it releases locally at once and reports `submitted`; the server ends that student's session. Which URL marks the *final* submit, not a section change, is test C4. | The Form's confirmation message links to the finish endpoint → 302 to `quitURL` → SEB quits (tests 4a/4b). The link text must be impossible to miss. |
| Teacher ends, or time runs out | Policy push, as today. **Plus a local expiry:** the extension stores `endsAt` and releases itself when it passes, even offline. Today it re-applies the cached lockdown policy when offline and ignores `endsAt`. | SEB can't be quit remotely while on Google's pages (§4). **When a session ends or expires, the dashboard shows its quit password prominently**, so the teacher can read it out. It is per-session, so revealing it after the session is harmless. |
| Lid closed / sleep | On wake the service worker may have restarted. The lock must re-attach its tab, window and focus handlers from stored state, then re-check `endsAt` and the server. Today the handlers are attached only when a lock first engages, so after a service-worker restart they are likely missing (test C5). Mac: SEB keeps running through sleep and resumes (test 4f). Windows: SEB keeps the system awake while running; lid close is unverified (§8.5 test 2). |
| Crash or reboot | Stored state re-engages or releases on startup, as for sleep. | "Re-Opening Locked Exam!" needs the quit password (§1.7). Covered by the same password reveal, and the dashboard shows the password to the teacher during the session too. |
| Stuck anyway | Teacher End, or IT ends the session on `/lockdown`. Local expiry is the backstop. | Quit password from the dashboard. IT keeps a runbook entry (Phase 5 deployment doc). |

A student who finished but is still locked is the worst outcome. The dashboard must make these cases stand out rather than hide them as "in progress": submitted but still locked, session ended but the device hasn't confirmed release, and expired sessions.

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
- **4f. Lid close.** Close the lid mid-Form for a minute, then open it. Repeat after submitting but before clicking the finish link. Record whether SEB resumes where it was, whether the Google session survives, and whether the finish link still quits.

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

**C4. Detecting submission.** Use a test Form with **two sections**. With the test student in a ClassGuard Lockdown Test, open the service worker console and run:
```js
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) console.log(d.transitionType, d.url);
});
chrome.webRequest.onCompleted.addListener((d) => {
  if (d.type === 'main_frame') console.log(d.method, d.statusCode, d.url);
}, { urls: ['*://docs.google.com/forms/*'] });
```
Click **Next** to section 2, then **Submit**. **Record** the URL and method logged for each. This decides how the extension tells a final submit apart from a section change.

**C5. Lid close and offline.** During a ClassGuard Lockdown Test:
- **C5a.** Close the lid for 2 minutes, then open it. Try a new tab and Alt+Tab. **Pass:** they are still corrected and logged. If not, the service worker lost its lock handlers.
- **C5b.** Turn Wi-Fi off, let the session's end time pass, then wait 2 minutes. Record whether the student is released while offline. Expected today: no.
- **C5c.** End the session from the teacher side while the lid is closed. Open the lid. Record how long release takes.

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
| 4f lid close | | |
| 5a wrapper, sign-in form | | |
| 5b wrapper, open form | | |
| 5c wrapper Finish | | |
| 6 locked mode on Mac | | |
| C1 Chromebook soft lock baseline | | |
| C2 forced fullscreen re-apply | | |
| C2b focus snap-back | | |
| C3 locked mode vs. extension | | |
| C4 submission URLs | | |
| C5a lid close, handlers | | |
| C5b offline expiry | | |
| C5c end while asleep | | |

## 6. Decisions needed at review

1. **Layout.** Confirm gate + direct, or wrapper if test 5 passes.
2. **Quit password policy.** One per session, shown to the teacher, or one district-wide unlock password held by IT? A per-session password limits the damage if it leaks.
3. **Full Disk Access.** Pre-grant it to SEB via an MDM PPPC profile (and keep `detectAccessibilityApps` on), or turn detection off?
4. **Fleet facts.**
   - The macOS versions on student MacBooks. Anything below 12.1 changes AAC behaviour.
   - Whether the MDM is Mosyle; ClassGuard already integrates with it.
   - Whether Workspace sign-in goes through a third-party IdP.
5. **Remote quit.** Is the teacher fallback in §4 (no remote quit while a student is on Google's pages) acceptable, or should SEB Server be investigated before Phase 2?
6. **Windows: if Google sign-in fails in SEB** (§8.2 #3, decided by §8.5 test 1). Options: Forms without sign-in with identity from ClassGuard; the Chrome soft lock on Windows, like Chromebooks; or no SEB on Windows.
7. **Windows: SEB service policy** (§8.2 #5). Warn if missing for the pilot, then require it?
8. **Windows: district agents** (§8.2 #6). Which always-on agents (RMM, MDM, security, classroom tools) must be exempted from SEB's prohibited-process list?
9. **Windows: VM detection** (§8.2 #7). Allow VMs in configs until SEB 3.10.3 fixes the false positives, or require 3.10.3?
10. **Accessibility accommodations** (§8.2 #11). A per-student flag for screen readers and the touch keyboard, which switches SEB for Windows to its other kiosk mode.
11. **Hosted configs on both platforms** (§8.2 #1). The embedded-config link doesn't work on Windows, so the Phase 1 config endpoint serves `.seb` files for Mac too.

### Later: open-notes tests (not in Phases 1–4)

Some tests allow notes, so they aren't a lockdown in the traditional sense, but the teacher still wants a simple workflow. Current thinking (2026-09-29):
- **Default: regular monitoring.** Run the test as a normal lesson session with the Form plus the allowed resources (e.g. Google Drive/Docs, Classroom) on the allowlist, and use live screens and tab history to watch. This needs no new code.
- **Possible middle tier:** "locked, with allowed resources". Same devices and flow as a lockdown, but the teacher adds allowed URLs. SEB's URL filter and the Chromebook soft lock's allow rules can both carry extra entries. Worth considering only if teachers ask for it.
- UI idea: a single "Start test" dialog with **Locked** / **Open notes (monitored)** instead of two separate features.

### Later: remote proctoring (not in Phases 1–4)

Question raised 2026-09-29: can the lockdown also video-proctor a student testing from home?

- **SEB has no webcam proctoring any more.**
  - SEB for Windows disabled its Jitsi Meet and Zoom video proctoring in March 2024 and deleted the code in April 2024; it is gone from every 3.10 release (seb-win-refactoring commits `956771c0`, `e8ebd284`).
  - SEB for macOS compiles both out: `JitsiMeetProctoringSupported NO`, `ZoomProctoringSupported NO` (SM `Classes/SEBController.h#L242-243`).
- **What remains is screen proctoring:** periodic screenshots plus metadata (active app, URL, window title), uploaded to the *SEB Server* screen-proctoring service. It needs a self-hosted SEB Server, and on macOS it makes SEB fall back from AAC to the classic kiosk (§1.6).
- **ClassGuard already covers screen monitoring for Chromebooks at home:** with the soft lock, the extension stays online, so Live View works wherever the device has internet. On Windows the extension stays online too, but SEB hides Chrome, so Live View can't show the exam. On Macs the extension is offline under AAC.
- **Webcam capture from the extension is technically possible** (camera access through an offscreen document, auto-granted by policy), but it's a privacy decision, not a technical one. Recordings of students are education records under FERPA. A federal court held a webcam room scan of a public-university student's home to be an unreasonable Fourth Amendment search (*Ogletree v. Cleveland State University*, N.D. Ohio 2022). This conflicts with this feature's own principle (state only, no screen recording).
- **Decision (2026-09-29):** no video proctoring in ClassGuard. For students testing remotely, the flow is **a teacher-run Google Meet alongside the soft lock**.

**Remote students on Macs and Windows laptops.** SEB and Meet can't run together:
- **Mac:** under AAC only SEB has network access and other apps are blocked; AAC doesn't allow background video conferencing (§1.6 known limits). Meet in Chrome would drop the moment SEB starts.
- **Windows:** SEB hides Chrome on its own desktop, prohibits Zoom and Teams by default, and allows only one display (§8.1). A Meet call in the hidden Chrome window isn't something to rely on.

So a remote student gets the **Chrome soft lock on every platform**, not SEB:
- The session allows a second tab for `meet.google.com` next to the Form. This is the "locked, with allowed resources" tier from the open-notes section, with Meet as the allowed resource.
- Forced fullscreen and focus snap-back (§1.10) work in Chrome on Mac and Windows too. The lock is softer than on a Chromebook, because Cmd+Tab / Alt+Tab to another app can't be prevented, only detected and reported. The teacher watching on Meet, plus Live View, which works because the extension stays online, covers the gap.
- **Choosing the mode.** ClassGuard already tells on-campus from off-campus devices by source IP (`resolvePolicy(studentId, 'on_campus' | 'off_campus')`). An off-campus Mac or Windows device could therefore default to "remote: soft lock + Meet", and an on-campus one to SEB, with a per-student teacher override in the start dialog.

## 7. What's in this commit / left to do

**In this commit:**
- This doc.
- `scripts/seb-spike/make-config.js`, which generates the test configs and links.
- Two static spike pages, `frontend/public/seb-spike/probe.html` and `wrapper.html`. They send no data anywhere. Remove them after the spike.

**Left to do:**
- Run section 5 on the test Mac and a test Chromebook, and §8.5 on a Windows test PC; fill in the results tables.
- Update `make-config.js` for Windows (§8.3) before the Windows tests.
- Review and decide section 6.
- Then Phase 1: config generation, the gate and finish endpoints, and the server-side Config Key check.

---

## 8. SEB for Windows: counterpart to §1–§5

**Status:** research done, hands-on tests pending. Everything below is checked against the SEB for Windows source, the official SEB docs, and Microsoft, Chromium, CEF and Google primary sources. Each "(Mac: §x)" note points to the macOS finding it confirms or contradicts. Items marked **unverified** need the Windows test PC (§8.5).

### Sources

Citations use these short names, plus the macOS ones from the top of this doc (DL, DEV-CK, DEV-INT, CHROMIUM).

| Short name | Source |
|---|---|
| **SW** | seb-win-refactoring at the **latest release, tag `v3.10.2` = [`397f8e12`](https://github.com/SafeExamBrowser/seb-win-refactoring/tree/397f8e124387c54a9a770809003dd2e31946dcd5)** (2026-05-08). Paths are relative to this commit; permalink = `https://github.com/SafeExamBrowser/seb-win-refactoring/blob/397f8e124387c54a9a770809003dd2e31946dcd5/<path>#L<a>-L<b>`. This is the current Windows repo: the README calls it "Safe Exam Browser for Windows", DL links its releases, and it is active and not archived. **The tag sits on release branch `3.10.2` and is not an ancestor of `master`.** |
| **SW-main** | `master` at [`016d2341`](https://github.com/SafeExamBrowser/seb-win-refactoring/tree/016d23413e3799ff6ac61e774ebaac81d4818682) (2026-09-25), 105 commits past the tag. The unreleased patch branch `3.10.3` is at `60898667` (2026-09-11). Differences from the tag are called out. |
| **WIN-MANUAL** | https://safeexambrowser.org/windows/win_usermanual_en.html |
| **WIN-RELNOTES** | https://safeexambrowser.org/windows/win_release_notes_en.html |
| **GH-REL** | https://github.com/SafeExamBrowser/seb-win-refactoring/releases/tag/v3.10.2 (via `gh api`) |
| **GH#n** | `https://github.com/SafeExamBrowser/seb-win-refactoring/issues/n` (or `/discussions/n`) |
| **CEF** | chromiumembedded/cef, branch `7727` (the CEF used by SEB 3.10.2's Chromium 147) at `76d24426` |
| **CHROMIUM-W** | chromium/src `main` at `5a1f0ec90b18` (2026-09-29), read through the GitHub mirror because googlesource returned 503. The macOS line references at `979281823a50` match it line for line. |
| **CR147** | chromium tag `147.0.7727.118` (the engine in SEB 3.10.2, per WIN-RELNOTES) |
| **GOOG-EMBED** | https://support.google.com/accounts/answer/7675428 |
| **GOOG-2020** | https://developers.googleblog.com/guidance-to-developers-affected-by-our-effort-to-block-less-secure-browsers-and-applications/ |
| **CEFSHARP-147** | https://github.com/cefsharp/CefSharp/releases/tag/v147.0.100 |
| **MS-SMODE** | https://support.microsoft.com/en-us/windows/windows-10-and-windows-11-in-s-mode-faq-851057d6-1ee9-b9e5-c30b-93baebeebc85 |
| **MS-NETFX** | https://learn.microsoft.com/en-us/dotnet/framework/install/versions-and-dependencies |
| **MS-WDA** | https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity |
| **CHROME-RT** | https://developer.chrome.com/docs/extensions/reference/api/runtime#type-PlatformOs |
| **CHROME-POL** | https://chromeenterprise.google/policies/ (read through `policy_templates_en-US.json`) |

---

### 8.1 Verified SEB for Windows facts

#### 8.1.1 Version, platform, license, install, service

**Version and platform**
- The latest release is **SEB 3.10.2 for Windows**, build 3.10.2.920, published **2026-05-08** (GH-REL; DL: "Current version for Windows 10 (Version 1803 or newer) and Windows 11").
- 3.10.3 is in development. The developers promise it "in the upcoming weeks", mainly to fix false virtual-machine detections (GH#1517, 2026-09-10; 3.10.3 dev build posted 2026-09-11). `master` is further ahead, and a developer calls it "version 4.0" (GH#1510).
- The browser engine is **CEF/CefSharp, Chromium 147.0.7727.118** (WIN-RELNOTES 3.10.2). WIN-MANUAL: "based on the Chromium Embedded Framework CEF". (Mac: WKWebView.)
- Supported: Windows 10 1803+ and Windows 11, 32- and 64-bit (WIN-MANUAL "Operating System"; README).
- **ARM64: there is no native build.**
  - Release assets are x64 MSI, x86 MSI and a SetupBundle.exe only (GH-REL).
  - The bundle installs the x64 MSI whenever `VersionNT64` is true (SW `SetupBundle/Bundle.wxs#L16-31`).
  - A developer reported a multi-minute startup delay for the x64 build under ARM emulation and recommended the **x86 build** as a workaround (GH#1024, 2024-11-18).
  - GH#1554 (open, 2026-09-25) reports the bundle failing on ARM64 with 0x80070666.
- **S mode: not possible.** In S mode only Microsoft Store apps can be installed (MS-SMODE), and SEB is an MSI/EXE.

**Installer and deployment**
- **Per-machine** WiX MSI (`InstallScope="perMachine"`, SW `Setup/Product.wxs#L5`). It installs to Program Files (WIN-MANUAL).
- The MSIs do **not** include the prerequisites. WIN-MANUAL: "you'll have to manually install the required runtime dependencies when using the MSI packages".
  - .NET Framework 4.8 comes with Windows 10 1903+ and Windows 11 (MS-NETFX).
  - The **Visual C++ 2015–2022 Redistributable must be deployed separately**. The bundle chains `vc_redist` with `/install /quiet /norestart` (SW `SetupBundle/VisualCppRuntime.wxs#L9-26`).
  - For Intune, GPO or other MDM: deploy VC++ first, then the MSI as a per-machine app. The silent switches are standard Windows Installer ones; test 0 checks them.
- **Admin rights are needed to install** "due to its Windows service component as well as file and protocol associations" (developer, GH#43).
- **Running SEB needs no admin rights.** `SafeExamBrowser.exe` and the Client are `asInvoker` (SW `SafeExamBrowser.Runtime/app.manifest#L7`, `SafeExamBrowser.Client/app.manifest#L7`), so standard student accounts can run it.

**Protocol and file registration** (SW `Setup/Components/Application.xslt#L18-34`)
- `HKCR\seb` and `HKCR\sebs` get `URL Protocol` and `shell\open\command = "…\SafeExamBrowser.exe" "%1"`.
- A `.seb` ProgId is registered with content type `application/seb`, so a double-clicked `.seb` file opens SEB.

**License**
- The repo `LICENSE.txt` is MPL 2.0, and so are the source headers.
- WIN-MANUAL still says "Mozilla Public License Version 1.1", which is out of date.
- Parts of the integrity code are native modules that ship with the binaries. The C# falls back when they are missing, e.g. `KeyGenerator` (SW `SafeExamBrowser.Configuration/Cryptography/KeyGenerator.cs#L100-117`). As on the Mac, we use the stock signed build.

**The SEB Service**
- It is installed as the Windows service `SafeExamBrowser`, running as **LocalSystem** with auto-start (SW `Setup/Components/Service.xslt#L13-15`).
- What it does: per session, it sets and restores registry policies and service states (SW `SafeExamBrowser.Service/Operations/LockdownOperation.cs#L46-61`):
  - the Ctrl+Alt+Del screen options: change password, lock, sign out, switch user, Task Manager, power options, Ease of Access, network selector;
  - Chrome's notification policy;
  - "find printer";
  - remote connections;
  - Windows Update.
- WIN-MANUAL (Security pane) says the service is "necessary to block and unblock some system features (the options in the Windows Security Screen invoked by Ctrl-Alt-Del) and pausing Windows Update".
- **SEB's own default is to ignore the service.** `Service.IgnoreService = true` (SW `SafeExamBrowser.Configuration/ConfigurationData/DataValues.cs#L292`), which dates back to 3.0.1 (WIN-RELNOTES: "bypass SEB service as default").
  - To use it, the config must set `sebServiceIgnore = false`.
  - `sebServicePolicy` then decides what happens when the service is unreachable: 0 allow, 1 warn, 2 refuse to start. The default is 2 (DataValues.cs `#L293`; SW `…/DataMapping/ServiceDataMapper.cs#L175-192`; SW `SafeExamBrowser.Runtime/Operations/Session/ServiceOperation.cs#L116-151`).
- **What fails without it:** Ctrl+Alt+Del still offers Task Manager, Lock, Sign out and Switch user, and Windows Update keeps running.
  - Lock and unlock events are then **ignored** by SEB (SW `SafeExamBrowser.Client/Responsibilities/MonitoringResponsibility.cs#L263-277`).
  - Remote-session detection and VM detection don't depend on the service (§8.1.4).

#### 8.1.2 Config file format

**What the Windows loader accepts** (SW `SafeExamBrowser.Configuration/DataFormats/`)
- **Raw XML plist**: a case-insensitive `<?xm` prefix, used as-is (`XmlParser.cs#L26`, `#L63-74`).
- The prefixes are `pswd`, `pwcc`, `plnd`, `pkhs` and `phsk` (`BinaryBlock.cs#L13-17`).
- **The outer gzip is optional** (`BinaryParser.cs#L86`).
- **The inner gzip after `plnd` is also optional** (`BinaryParser.cs#L139-145`). (Mac: the inner gunzip is mandatory, so keep emitting either raw XML or `gzip("plnd"+gzip(xml))`.)
- The file must start with `<?xm`: a UTF-8 BOM would break detection. make-config.js emits no BOM.

**Value parsing**
- `<string/>` becomes null and `<string></string>` becomes "". Both serialize as `""` in the Config Key JSON (`XmlParser.cs#L266`; `Json.cs#L95-103`).
- An unknown element type fails the whole load (`XmlParser.cs#L271-278`).
- Keys the client doesn't recognize are ignored, and so are values of the wrong type. Every mapper checks the value's type, e.g. `value is bool`.

**`sebConfigPurpose`**
- Only the value 1 means "configure client". **Any other value, including 0 and 2, is an exam session**, since Windows has no "managed" purpose (SW `…/DataMapping/ConfigurationFileDataMapper.cs#L28-36`).
- An exam config is never written to `SebClientSettings.seb`. Only purpose 1 calls `ConfigureClientWith` (SW `SafeExamBrowser.Runtime/Operations/Session/ConfigurationOperation.cs#L182-185`).
- What purpose 0 still leaves on disk:
  - logs in `%LocalAppData%\SafeExamBrowser\Logs` (WIN-MANUAL);
  - the browser cache, which is deleted at shutdown by default (`removeBrowserProfile`; DataValues.cs `#L180`);
  - the encrypted session-integrity cache `%LocalAppData%\SafeExamBrowser\Temp\cache.bin` (§8.1.7).
- **The machine's client config is loaded first.** If `%ProgramData%\SafeExamBrowser\SebClientSettings.seb` (or the `%AppData%` one) exists, SEB loads it before the link. It is only used to decrypt a password-protected exam config (`ConfigurationOperation.cs#L112-131`), so it doesn't affect our plain configs.

**Malformed values**
- **3.10.2 does not validate `hashedQuitPassword`.** Any string is accepted (`SecurityDataMapper.cs#L152-158`). (Mac 3.7.1: a malformed hash fails the load.)
- **3.10.3 and `master` add a `DataValidator`** (SW-main `SafeExamBrowser.Configuration/ConfigurationData/DataValidator.cs#L43-65`, `#L96-112`, called from `ConfigurationRepository.cs#L143`; also on branch `3.10.3`). It fails the load (InvalidData) when:
  - `hashedAdminPassword`, `hashedQuitPassword` or `sebServerFallbackPasswordHash` is not empty and not 64 hex characters;
  - **any key or string value contains `"` followed by optional whitespace and a comma**.
  - ClassGuard must never emit `",` in any string, e.g. inside a Form URL or a filter expression.
- **The quit-password hash is not NFC-normalized on Windows.** `HashAlgorithm.GenerateHashFor` is plain `SHA256(UTF8(password))` as lowercase hex, and the comparison ignores case (SW `SafeExamBrowser.Configuration/Cryptography/HashAlgorithm.cs#L19-29`; `SafeExamBrowser.Client/Responsibilities/ClientResponsibility.cs#L151-152`). (Mac: NFC first.) **Use ASCII-only quit passwords** so one hash works on both.

#### 8.1.3 `seb://` / `sebs://` links

**How a link reaches SEB**
- Chrome launches `"SafeExamBrowser.exe" "<url>"` through the HKCR registration.
- The runtime takes `args[1]` as the config URI (`ConfigurationOperation.cs#L404-416`).
- `NetworkResourceLoader` maps `seb`→`http` and `sebs`→`https` and fetches with .NET `HttpClient`, sending `User-Agent: SEB/<version>` (SW `SafeExamBrowser.Configuration/DataResources/NetworkResourceLoader.cs#L36-42`, `#L89-108`, `#L133-146`).

**Request sequence for a hosted config**
1. `CanLoad` sends a **HEAD**. If that isn't 2xx or 401, it sends a **GET** (`#L165-204`).
2. `TryLoad` then sends **another GET** (`#L66-87`).
3. **So each launch makes two or three requests.** The config endpoint must be idempotent: expire tokens by time, not on first fetch.

**Responses** (Mac: §1.3 differs; see "HTTP error pages")
- **Non-2xx other than 401:** no loader matches, and the result is `NotSupported`. SEB shows a "not supported configuration resource" message and quits (`ConfigurationOperation.cs#L371-402`; SW `SafeExamBrowser.Runtime/RuntimeController.cs#L44-80`, `App.cs#L68-75`).
- **`Content-Type: text/html` or HTTP 401 → `LoadWithBrowser`.** SEB starts with **default settings plus that URL as the start URL**. It also clears the prohibited and permitted lists, **ignores the service**, **allows VMs** and allows reconfiguration (`NetworkResourceLoader.cs#L77-80`, `#L148-163`; `ConfigurationOperation.cs#L201-220`).
  - **The config endpoint must never answer an expired or invalid token with an HTML page or a 401.** Return 404 or 410 as `text/plain`.
- **Any other 2xx body** goes to the parsers. The unused `SupportedContentTypes` list aside, there is no Content-Type check. `application/seb`, `application/octet-stream` and `text/xml` all work.

**Embedded config `sebs://application/seb;base64,…`: not supported at launch on Windows.** (Mac: supported.)
- The runtime has only `FileResourceLoader` and `NetworkResourceLoader` (SW `SafeExamBrowser.Runtime/CompositionRoot.cs#L228-230`). The link would become `https://application/seb;base64,…`, fail, and SEB would quit.
- The `data:` rewrite exists only inside a **running** SEB browser, for links clicked in a page (`SafeExamBrowser.Browser/Handlers/RequestHandler.cs#L121-159`).
- **Therefore Windows needs a hosted config, `sebs://<classguard>/…/<token>.seb`.**
- Separately, Chrome ≤ M140 silently dropped external-protocol URLs over 2048 characters on Windows. The limit was removed in M143 (CHROMIUM-W `chrome/browser/platform_util_win.cc#L88-115`; removal commit `7373ed96`, first in 143.0.7463.0). Short hosted links avoid the question.

**Per-student token `??token=`**
- If the link's query contains a second `?`, SEB stores the part from the last `?` as the start-URL query (`ConfigurationOperation.cs#L246-257`).
- With `startURLAppendQueryParameter = true` (default false, DataValues.cs `#L205`), it is appended to the start URL: `&token=…` if the start URL already has a query, otherwise `?token=…` (SW `SafeExamBrowser.Browser/BrowserApplication.cs#L293-310`).
- **The download URL is not stripped on Windows** (Mac strips it). The HEAD and GETs go to `https://host/x.seb??token=…`, so the server sees a first parameter named `?token`. The config endpoint must tolerate or ignore it.

**SEB already running**
- A second `SafeExamBrowser.exe` is blocked by a global mutex. It shows "You can only run one instance of SEB at a time." and exits, and **the link is not passed to the running instance** (SW `SafeExamBrowser.Runtime/App.cs#L19`, `#L39-54`). (Mac: refused unless `examSessionReconfigureAllow` and the URL match.)
- In-browser reconfiguration exists but needs `examSessionReconfigureAllow` and a matching `examSessionReconfigureConfigURL` when a quit password is set (SW `SafeExamBrowser.Client/Responsibilities/BrowserResponsibility.cs#L126-153`). We don't use it.
- **Unverified:** which desktop that second-instance message box appears on while SEB owns a new desktop.

**Config load fails at launch:** SEB shows an error dialog and quits (`ConfigurationOperation.cs#L371-402`; `RuntimeController.cs#L44-80`). (Same as Mac.)

#### 8.1.4 Settings

All defaults come from SW `SafeExamBrowser.Configuration/ConfigurationData/DataValues.cs` and key names from `Keys.cs`.

**macOS §1.4 keys on Windows**

| Key | Honored on Windows? | Windows default | Notes / source |
|---|---|---|---|
| `sebConfigPurpose` | yes | exam | 1 = client config, anything else = exam (§8.1.2) |
| `startURL` | yes | `https://www.safeexambrowser.org/start` | `#L202` |
| `lockdownModePolicy` | **no** (Mac-only) | n/a | no Windows mapping; still counts in the Config Key (§8.1.5) |
| `browserWindowWebView` | **no** (Mac-only) | n/a | one engine (CEF) |
| `sendBrowserExamKey` | **yes: sends both headers** | false | `BrowserDataMapper.cs#L492-499` (see 8.1.5) |
| `URLFilterEnable` / `URLFilterEnableContentFilter` | yes | off | content filter only applies if main filter is on (`BrowserDataMapper.cs#L475-482`); **content filtering works in CEF** (`ResourceHandler.cs#L149-171`), unlike the Mac doc/code discrepancy |
| `URLFilterRules` | yes, same `{active, regex, expression, action}` format; action 1 = allow, anything else = block | none | `BrowserDataMapper.cs#L604-640`; block rules first, then allow, unmatched = **block** (`Filters/RequestFilter.cs#L23-64`); start URL auto-allowed (`BrowserWindow.cs#L299-307`); simplified rules: host `a.b` also matches subdomains, a leading `.` pins the exact host, path is anchored (optional trailing `/`), a rule without a query matches any query, `?.` forbids a query (`Filters/Rules/SimplifiedRule.cs#L94-150`; WIN-MANUAL Filter Section) |
| `examSessionClearCookiesOnStart` / `…OnEnd` | yes | true / true | `#L181-182` |
| `allowBrowsingBackForward` | yes | false | `#L185-187`, `BrowserDataMapper.cs#L247-254` |
| `browserWindowAllowReload` | yes | true, **with reload warning** (`showReloadWarning` true) | `#L188`, `#L193`; F5 is enabled by default (`#L227`) |
| `quitURL` | yes | "" | §8.1.7 |
| `quitURLConfirm` | yes | **false** (Mac: true) | never set in DataValues, so it is the C# default (`Settings/Browser/BrowserSettings.cs#L87`); we set false anyway |
| `hashedQuitPassword` | yes | "" | no NFC; unvalidated in 3.10.2 (§8.1.2) |
| `detectAccessibilityApps` | **no** (Mac-only) | n/a | Windows has its own Ease-of-Access check (§8.1.6) |
| `allowOpenAndSavePanel` | **no** (Mac-only) | n/a | use the Windows keys below |
| `browserUserAgent` (suffix) | yes | none | `BrowserDataMapper.cs#L580-586` |
| `browserUserAgentMac`, `…MacCustom` | **no** | n/a | Windows equivalents: `browserUserAgentWinDesktopMode` (0 = default, anything else = custom) + `browserUserAgentWinDesktopModeCustom`; touch mode uses `browserUserAgentWinTouchMode` / `…Custom` (`BrowserDataMapper.cs#L561-578`) |

**User agent**
- The default is `Mozilla/5.0 (Windows NT <major.minor>) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<full Chromium version> SEB/<version>`.
- A custom UA still gets ` SEB/<version>` appended (SW `SafeExamBrowser.Browser/BrowserApplication.cs#L476-497`). As on the Mac, SEB can never pass as plain Chrome.

**File upload and download** (Windows-specific keys)
- `allowDownloads` defaults to **true** and `allowUploads` to **false** (`#L173`, `#L179`). The combined key was removed in 3.9.0 (WIN-RELNOTES 3.9.0).
- For Forms: set `allowDownloads = false`. Set `allowUploads = true` only if a Form has file-upload questions, which also needs Google Drive (§8.1.8).
- `downloadAndOpenSebConfig` defaults to true (`#L171`). Harmless, because reconfiguration isn't allowed while a quit password is set.

**Windows-only keys we must decide on**

| Key | Default | Recommendation / notes |
|---|---|---|
| `createNewDesktop` / `killExplorerShell` | new desktop (`#L266`; mapping `SecurityDataMapper.cs#L131-150`) | **`createNewDesktop = true`**. Chrome and everything else stays on the original desktop, out of reach. `killExplorerShell` is needed only for the touch on-screen keyboard or the NVDA/JAWS screen readers: "Screen readers NVDA and JAWS are not compatible with kiosk mode Create New Desktop" (WIN-RELNOTES, all 3.x); "The Windows on-screen keyboard is not working with the Create New Desktop kiosk mode" (WIN-MANUAL). Decide per student for accommodations. |
| `sebServiceIgnore` / `sebServicePolicy` | true / 2 | **`false` / 1 (warn) for the pilot, 2 once the service is proven on the fleet** (§8.1.1). |
| `allowVirtualMachine` | false (`#L269`) | **3.10.1/3.10.2 flag real laptops as VMs**: Dell Latitude 3420/5500, HP ProDesk 600 G6, Intel Core Ultra (GH#1510, GH#1517, GH#1542, open). The fix is due in 3.10.3. VM detection guards against BYOD tricks and matters little on managed laptops with standard accounts. **Set `true` unless 3.10.3 is deployed and test 2 passes.** The check aborts before the session starts (`Runtime/Operations/Session/VirtualMachineOperation.cs#L44-59`). |
| `allowScreenSharing` | false | Maps to **both** "allow window capture" and "allow remote connections" (`Keys.cs#L266`, `#L305`). While false, SEB **refuses to start in a remote (RDP) session** (`RemoteSessionOperation.cs#L43-58`) and sets `WDA_EXCLUDEFROMCAPTURE` on its windows (`Client/Operations/WindowGuardOperation.cs#L35-44`; `UserInterface.Shared/Utilities/WindowExtensions.cs#L55`; MS-WDA: Windows 10 2004+, "not a security feature"). Keep false. |
| `insideSebEnable*` (Switch User, Lock, Change Password, Task Manager, Log Off, Shut Down, Ease of Access, Network selector, VMware shade) | all disabled | Only enforced when the service is used (`LockdownOperation.cs#L46-61`). Keep the defaults. |
| `enableWindowsUpdate` | disabled | Service only. Keep disabled so updates can't reboot mid-Form. |
| `enableChromeNotifications` | disabled | With the service active, SEB **writes `HKU\<SID>\Software\Policies\Google\Chrome\DefaultNotificationsSetting = 2`** during the session and deletes it afterwards (`Lockdown/…/UserHive/ChromeNotificationConfiguration.cs`). This could conflict with a district user-level Chrome policy. **Consider `true`** so SEB leaves Chrome's policy alone; Chrome's windows are hidden anyway. |
| `prohibitedProcesses` | 54 built-in entries (`#L103-156`) | See below. |
| `permittedProcesses` | none | Keep empty. |
| `enableAltTab`, `enableStartMenu`, `enablePrintScreen`, `enableF1…F12`, `enableRightMouse`, … | keyboard hook (§8.1.6) | Keep the defaults. |
| `clipboardPolicy` | isolated (`#L264`) | Clipboard is limited to SEB (Mac AAC clears the pasteboard instead). Keep. |
| `allowedDisplaysMaxNumber` / `allowedDisplayBuiltinEnforce` / `allowedDisplaysIgnoreFailure` | 1 / false / false (`#L210-213`) | **SEB refuses to start with a second display attached** (projector, dock monitor) (`Runtime/Operations/Session/DisplayMonitorOperation.cs#L45-64`). Keep 1 and tell teachers; test 2 checks the message. |
| `enableSessionVerification` | true (`#L268`) | Crash-recovery lock (§8.1.7). Keep. |
| `enableCursorVerification`, `allowStickyKeys` | true / false | Can **abort the session** on custom cursor schemes or tampered Ease-of-Access (`Runtime/Operations/Session/SessionIntegrityOperation.cs#L27-40`, `#L95-130`). Keep; note for support. |
| `disableSessionChangeLockScreen` | false | With the service active, a lock, unlock or user switch shows SEB's red lock screen, which needs the quit password to resume (`MonitoringResponsibility.cs#L263-300`; `ClientResponsibility.cs#L135-170`). Test 2 covers lid close. |
| `touchOptimized` | desktop | Touch mode needs `killExplorerShell` (WIN-MANUAL). |

**Default prohibited processes** (3.10.2, SW DataValues.cs `#L103-156`)
- The list includes: **Teams.exe, MS-teams.exe (new Teams), Zoom.exe, Discord.exe (and PTB/Canary), slack.exe, spotify.exe, VLC.exe, Microsoft.Media.player.exe**, Skype, Telegram, Element, Guilded, OBS, Camtasia, TeamViewer.exe, VNC, WebEx, GoToMeeting, join.me, **mstsc.exe**, **chromoting.exe / remoting_host.exe (Chrome Remote Desktop)**, **PCMonitorSrv.exe / pcmontask.exe**, and **sethc.exe** (Sticky Keys).
- **chrome.exe, msedge.exe and ClassGuard are not on it.**
- The SEB Config Tool adds `Chrome.exe`, `Firefox.exe` and other browsers **only when a config is saved in Disable-Explorer-Shell mode** (SW `SebWindowsConfig/SEBSettings.cs#L818-829`, `#L1619-1623`). Our server-generated configs never pass through the tool.
- **The list grows.** Branch `3.10.3` adds TeamViewer_Desktop/Service, tv_w32/x64 and UltraViewer. **`master` (4.0) adds 35 more (95 in total), mostly remote-support and RMM agents**: `screenconnect.client.exe`, `screenconnect.service.exe`, `ninjarmmagent.exe`, `logmein.exe`, `splashtopstreamer.exe`, `quickassist.exe`, `AnyDesk.exe`, `MouseWithoutBorders.exe`, … (SW-main `DataValues.cs#L104-198`).

**How prohibited processes are handled**
- **At startup** (SW `ApplicationMonitor.cs#L278-308`; `Client/Operations/ApplicationOperation.cs#L83-106`, `#L144-199`):
  - SEB asks the student to let it terminate running prohibited apps. **"No" aborts the launch.**
  - If termination fails, for example because the process is a **SYSTEM service**, the launch fails.
- **During the session:** a newly started prohibited process is killed. If that fails, SEB shows the red lock screen, which needs the quit password (`ApplicationMonitor.cs#L391-435`; `MonitoringResponsibility.cs#L140-161`).
- **Disabling a default entry:** a config entry with the same `executable` and `originalName`, `os = 1` and `active = false` removes it (SW `…/DataMapping/ApplicationDataMapper.cs#L40-77`; WIN-MANUAL: defaults "cannot be removed … But you can deactivate").
- **Action:** inventory the district's agents (RMM, MDM, remote support, classroom-management tools) and deactivate any on this list, **especially before SEB 4.0 ships**.

#### 8.1.5 Config Key / Browser Exam Key

**Engine and headers**
- The engine is CEF/CefSharp; HTTP headers **do** work.
- With `sendBrowserExamKey = true`, SEB adds `X-SafeExamBrowser-ConfigKeyHash` and `X-SafeExamBrowser-RequestHash`. They go on **main-frame requests** and on requests to the **same host as the current page** (SW `SafeExamBrowser.Browser/Handlers/ResourceHandler.cs#L126-147`).
  - That means they would also be sent on top-level navigations to Google.
- The default is off (DataValues.cs `#L199-200`). (Mac: headers only in the deprecated classic WebView.)

**JavaScript API** (SW `SafeExamBrowser.Browser/Content/Api.js#L9-16`; `Handlers/RenderProcessMessageHandler.cs#L37-45`)
- Injected on every JS context creation. For each frame it computes the keys from **that frame's URL**:
  ```js
  SafeExamBrowser = { version: 'SEB_Windows_<build>',
    security: { browserExamKey: '<hash>', configKey: '<hash>', updateKeys: (callback) => callback() } }
  ```
- **`updateKeys(cb)` calls the function you pass directly and synchronously, with no arguments.** (Mac: it takes a *named global* function and runs `name + "();"`.)
  - **Portable pattern:** declare `function cgKeysReady(){…}` at global scope and call `SafeExamBrowser.security.updateKeys(cgKeysReady)`. This satisfies both platforms (Mac side per §1.5; confirm in test 0).
- DEV-CK says Windows 3.3.2+ sets the variables at page load without `updateKeys`.
- **Injection is asynchronous** (`frame.ExecuteJavaScriptAsync`), and an open report shows `SafeExamBrowser` intermittently `undefined` at `DOMContentLoaded` (GH#1443, open since 2026-04, not reproduced by the developers).
  - **The gate page must poll**, e.g. every 100 ms for up to about 5 s. It must not treat a missing API as "not SEB" on the first check.
- `SafeExamBrowser.version` is `SEB_Windows_<build>`, not the DEV-CK format.

**Hash per URL** (SW `SafeExamBrowser.Configuration/Cryptography/KeyGenerator.cs#L53-69`)
- `sha256_hex(url_without_fragment + configKey)`, the same as Mac. The hash covers the full URL, **including any `?token=` that SEB appended**.

**Config Key derivation** (SW `ConfigurationData/DataProcessor.cs#L49-65`, `ConfigurationData/Json.cs#L19-105`)
- SHA-256 over SEB-JSON built from **the keys actually in the file**, with no defaults added (DEV-CK: "only uses setting key/values … actually contained in an opened config file").
- `originatorVersion` is dropped and empty dicts are skipped.
- Keys are sorted with `StringComparer.InvariantCulture`. For ASCII-letter keys this gives the same order as a case-insensitive sort.
- No whitespace, **no escaping**; `<data>` becomes Base64 and `<date>` becomes `ToString("o")`.
- **The same computation as Mac for the configs we emit**: ASCII keys, no `<real>`, no `<date>`, no `<data>`. DEV-CK: "SEB for Windows and SEB for iOS will generate the same key as SEB for macOS." **One server-side Config Key therefore serves both platforms.** Test 0 confirms it by comparing the Mac and Windows probe hashes for the same URL.
- Mac-only keys (`lockdownModePolicy`, `browserWindowWebView`, `detectAccessibilityApps`, `allowOpenAndSavePanel`) are ignored by the Windows client but **still hashed**. That is fine, because both platforms hash the same file.
- **Quirks to avoid:**
  - If the alphabetically last key is `originatorVersion` or an empty dict, Windows emits a trailing comma (`Json.cs#L41-44`). So emit no `originatorVersion` and no empty dicts.
  - `<real>` values format differently from Mac's `%.15g`. We emit none.
- **Browser Exam Key:** differs per platform, build and x86/x64 (WIN-RELNOTES: "different for the 32-bit (x86) and 64-bit (x64) build"). Don't use it.

#### 8.1.6 Lockdown strength (no AAC on Windows)

**What SEB blocks** (kiosk mode, WIN-MANUAL "Features" and Security pane)
- **Desktop.** With **Create New Desktop**, SEB runs on a fresh Win32 desktop, so the taskbar, Start menu, other windows and notifications of the original desktop are invisible and unreachable (`Runtime/Operations/Session/KioskModeOperation.cs#L120-133`). With **Disable Explorer Shell**, Explorer is killed and restarted afterwards.
- **Keyboard hook** (SW `SafeExamBrowser.Monitoring/Keyboard/KeyboardInterceptor.cs#L47-88`):
  - always blocked: the Apps key, **Alt+Tab**, **Alt+Space**, and **all injected keystrokes** (since 3.10.0; an opt-out, `enableInjected`, exists only on `master`: SW-main `Keys.cs#L211`);
  - blocked by default: LWin/RWin (**Win key**), **PrintScreen**, Alt+F4, Alt+Esc, Ctrl+Esc.
  - F1–F12, Esc and Ctrl+C/V/X stay enabled, with the clipboard isolated.
- **Other applications.** Windows of processes that aren't SEB and aren't permitted are **hidden** when they come to the foreground or appear as overlays. If hiding fails, SEB closes them, and if that fails, **kills the process** (`ApplicationMonitor.cs#L125-143`, `#L233-258`, `#L437-461`).
- **Ctrl+Alt+Del** can't be hooked. Its options are removed **only through the service** (§8.1.1).
- **Screen capture.** `WDA_EXCLUDEFROMCAPTURE` on SEB's windows, and PrintScreen is blocked.
- **Remote sessions.** SEB refuses to run in an RDP session unless `allowScreenSharing` is set. 3.10.2 adds "Improved remote session detection" (WIN-RELNOTES).
- **Other checks:** VM detection, the display count, and integrity checks for cursors, Ease of Access and Sticky Keys (§8.1.4).

**Network: other software stays online. This is the key difference from Mac.**
- WIN-MANUAL (Applications pane): "SEB only has a URL filter for the built-in browser, other applications and the system are not blocked from accessing the internet."
- **Chrome is not killed and not prohibited by default** (§8.1.4). Its windows are hidden, or out of sight on the original desktop.
- So the **ClassGuard extension's service worker should keep running and keep heartbeating** during the SEB session. (Mac/AAC: offline.) Test 2 must confirm this.
- **Caveat:** any Chrome window that appears during the session (the extension opening a tab, a Chrome prompt) gets hidden. If hiding fails, the Chrome process holding it could be killed (`ApplicationMonitor.cs#L233-258`). **On Windows the extension must not open windows, tabs or notifications while SEB is active.**

#### 8.1.7 Quitting

**Quit URL matching**
- The pattern is `^` + escaped(`quitURL` with trailing `/` trimmed) + `/?$`, **case-insensitive**, matched against the full request URL (SW `SafeExamBrowser.Browser/Handlers/RequestHandler.cs#L161-181`).
- It is an **exact match**: query strings must match, and an optional trailing slash is allowed. It is **not a prefix match**. WIN-RELNOTES 3.6.0: "Fixed bug with quit URL where URLs not exactly matching the quit URL would also trigger a shutdown."
- (Mac: exact after trimming leading and trailing `/`, and case sensitivity isn't stated. Pick a lowercase quit URL without a query and both platforms behave the same.)

**Where it's checked**
- In `OnBeforeBrowse` for **every frame**, **before** the URL filter, and the navigation is cancelled (`RequestHandler.cs#L78-86`). So the quit URL needn't be allowlisted, and the server never sees the request to it.
- **Redirects count.** CEF calls `OnBeforeBrowse` from a navigation throttle with `is_redirect = WasServerRedirect()` (CEF `libcef/browser/net/throttle_handler.cc#L79-86`, `#L97-103`). **A 302 from the finish endpoint to the quit URL should therefore trigger the quit** (test 4b).
- It also fires inside iframes, unlike a top-level-only check.

**Password and settings**
- The quit URL bypasses the quit password and `allowQuit`: it goes straight to `TryRequestShutdown()` with no password check (`SafeExamBrowser.Browser/BrowserWindow.cs#L638-673`; `SafeExamBrowser.Client/Responsibilities/ClientResponsibility.cs#L100-113`). WIN-MANUAL: "The password is not prompted when using a Quit Link".
- `quitURLRestart = true` would reset the browser instead of quitting, and defaults to false (DataValues.cs `#L198`).

**Crash and reboot recovery: the Windows equivalent of "Re-Opening Locked Exam"**
- When a quit password is set and `enableSessionVerification` is on (default), SEB caches the session's (Config Key, start URL) at start and clears it on a clean quit (SW `SafeExamBrowser.Client/Responsibilities/IntegrityResponsibility.cs#L101-142`, `#L186-208`; `SafeExamBrowser.Configuration/Integrity/IntegrityModule.cs#L212-230`).
- After a crash, a kill or a reboot, opening a config with the **same Config Key or the same start URL** shows a red lock screen: "The last session with the currently active configuration or start URL was not terminated properly! Please enter the correct password to unlock SEB." (SW `SafeExamBrowser.I18n/Data/en.xml#L210-212`).
- The quit password clears it (`ClientResponsibility.cs#L135-170`).
- The cache is per user: `%LocalAppData%\SafeExamBrowser\Temp\cache.bin`.
- **With per-session configs**, only reopening *the same session's* link triggers the lock.
- **Client crash:** the runtime shows an error and exits (`Runtime/Responsibilities/ClientResponsibility.cs#L67-91`).
- **Registry lockdown after a crash:** restored by the service when SEB next runs and quits, on reboot, or on uninstall, or with `SafeExamBrowser.ResetUtility.exe` run as admin (WIN-MANUAL Registry pane).

#### 8.1.8 Google sign-in, Forms, iframes

**Google says CEF sign-in is blocked**
- GOOG-EMBED: "Google might stop sign-ins from browsers that … Are embedded in a different application". Also: "If you implemented "Sign in with Google" with the Chromium Embedded Framework, you'll need to migrate".
- GOOG-2020: "Google Account sign-ins from all embedded frameworks will be blocked starting on January 4, 2021. This block affects CEF-based apps". Also: "We do not allow sign-in from browsers based on frameworks like CEF". And: "The browser must not use another browser's User-Agent string".
- CEFSHARP-147, the CefSharp release matching SEB 3.10.2's engine, still says "Google will block logins from CEF based browsers to Google Services, this includes Gmail, Drive, Docs".
- The CEF maintainer: "You should expect Google login not to work in CEF or any other unbranded Chromium-based browser" (https://magpcss.org/ceforum/viewtopic.php?f=6&t=18165, 2021).
- This is **more explicit than anything Google says about WKWebView** (Mac §1.8).

**SEB-side evidence is thin and old**
- No SEB issue or discussion reports the "This browser or app may not be secure" page.
- Two indirect reports say Google sign-in worked in SEB for Windows: GH#498 (2022, SEB 3.4: "a quiz that contains a link to login to google account first … starts without any issues") and GH discussion #122 (2021).
- Discussion #1432 (2026-03) reports an unexplained error after a Google login in 3.10.0 and has no replies.
- The SEB developers: "We … are not using nor have any experience with Google Workspace" (GH#511, 2022).
- **Treat Google sign-in in SEB for Windows as likely blocked until test 1 proves otherwise.**
- Spoofing a Chrome UA is against Google's stated rules (GOOG-2020), and SEB appends `SEB/x.y` anyway.

**Iframes and third-party cookies** (Mac: blocked by ITP)
- SEB sets no cookie policy or Chromium feature flags; it only uses switches like `disable-pinch` and `use-fake-ui-for-media-stream` (SW `BrowserApplication.cs#L321-366`, `#L431-441`).
- Chromium 147 defaults to `kIncognitoOnly`, so **third-party cookies are allowed** in a normal profile (CR147 `components/content_settings/core/browser/cookie_settings.cc#L82-88`). The 3PC-deprecation features are off by default (CR147 `components/content_settings/core/common/features.cc#L75`).
- `accounts.google.com` sign-in pages still return `X-Frame-Options: DENY` (observed 2026-09-29).
- **So on Windows the wrapper layout works only if the student has already signed in at top level in the same SEB session.** Sign-in can never happen in the frame. That doesn't help the cross-platform design, and sign-in itself is the open question.
- A form that doesn't require sign-in rendered in an iframe: a public `/viewform?embedded=true` returned no XFO (observed 2026-09-29).

**Google Forms locked mode** requires a managed Chromebook (https://support.google.com/docs/answer/7634943), and the page doesn't mention Windows. Treat it as blocking on Windows too (test 6).

#### 8.1.9 Launching from Chrome on Windows

**Same code path as macOS**
- `URLAllowlist` → `LaunchUrlWithoutSecurityCheck` (no prompt, no anti-flood) and `AutoLaunchProtocolsFromOrigins` are platform-independent (CHROMIUM-W `chrome/browser/chrome_content_browser_client.cc#L1206-1353`; `chrome/browser/external_protocol/external_protocol_handler.cc#L297-328`, `#L614-631`).
- Supported platforms (CHROME-POL):
  - URLAllowlist: `chrome.*` from 86;
  - AutoLaunchProtocolsFromOrigins: `chrome.*` from 85.
- **§1.9's recommendation (URLAllowlist `sebs://*`) carries over unchanged.**

**Windows-specific details**
- Chrome looks up the handler through `AssocQueryString`/HKCR and requires the `URL Protocol` value, which SEB's installer writes (CHROMIUM-W `chrome/browser/shell_integration_win.cc#L161-219`).
- Chrome's prompt is the same dialog on both platforms: "Open $1?" / "$ORIGIN wants to open this application." (`chrome/browser/ui/views/external_protocol_dialog.cc#L93-115`).
- **Launch.** Chrome escapes the URL, quotes it and calls `ShellExecuteA` (`platform_util_win.cc#L88-115`). A failure is **silent**: the return value is ≤ 32 and no UI is shown.
  - Base64 characters `+ / =` pass through unescaped. This is moot for hosted links.
- **Unverified:** whether Windows shows any extra UI of its own. Nothing in Chrome's path adds one.
- **Command-line cap:** 32,767 characters for CreateProcess (https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw).

**Platform detection:** `chrome.runtime.getPlatformInfo().os === 'win'` on Windows. The enum is `mac`, `win`, `android`, `cros`, `linux`, `openbsd` (CHROME-RT; CHROMIUM-W `extensions/common/api/runtime.json#L98-108`).

**Anti-flood without the policy:** each extension API call re-arms Chrome's "one launch without a gesture" flag, so each `tabs.update` gets one launch. The same applies on Mac (CHROMIUM-W `extensions/browser/extension_function_dispatcher.cc#L411-413`).

#### 8.1.10 Other things a district must know

- **Deploy per machine** with admin rights: the MSI plus the VC++ redistributable. Students run SEB as standard users (§8.1.1).
- **Antivirus and EDR.**
  - SEB installs a low-level keyboard hook, a SYSTEM service that edits HKLM/HKU policy keys, and a process killer.
  - WIN-RELNOTES 3.0.1 records anti-malware false positives that "blocked the SEB Windows Service".
  - GH#1443's reporter suspects Defender in intermittent failures (unconfirmed).
  - An intermittent "You can only run one instance" after a Windows 11 25H2 upgrade was left unresolved as "an issue on your side" (GH#1480).
  - **Pilot on the district image with the district EDR, and allowlist `C:\Program Files\SafeExamBrowser\` if needed.**
- **Multiple monitors:** SEB refuses to start with more than one display by default (§8.1.4).
- **Touch 2-in-1s.** The on-screen keyboard doesn't work with Create New Desktop (WIN-MANUAL). All injected key events are blocked in 3.10.x. **Unverified:** whether the Windows touch keyboard's input counts as injected. Test 2.
- **Accessibility.** NVDA and JAWS need Disable Explorer Shell (WIN-RELNOTES). Assistive tools that inject keystrokes broke in 3.10.0 (GH#1284, GH#1310); the opt-out exists only on `master`. **Plan per-student accommodations.**
- **Windows Hello and lock.**
  - Without the service, lock and unlock are ignored, so the student can lock and unlock with Hello and return to SEB.
  - With the service, Lock is disabled. Any session lock or switch shows SEB's red lock screen, which needs the quit password (§8.1.4).
  - Lid close and sleep behaviour is **unverified** (test 2).
- **Power.** `displayAlwaysOn` and `systemAlwaysOn` default to true (DataValues.cs `#L211`, `#L298`), which prevents idle sleep during the session.
- **Logs** are in `%LocalAppData%\SafeExamBrowser\Logs\*_Runtime.log`, `*_Client.log` and `*_Browser.log`. The Browser log records blocked URLs (WIN-MANUAL). The default log level is Debug (`#L238`).

---

### 8.2 Differences from macOS that change the design

| # | Windows fact | Design consequence |
|---|---|---|
| 1 | **No embedded-config links at launch.** `sebs://application/seb;base64,…` fails (§8.1.3). | **Host the config on both platforms:** `sebs://<classguard>/lockdown/seb/<token>.seb`. The config endpoint must: answer **HEAD and GET, repeatably** (2–3 requests per launch, so expire by time, not on first use); return **no HTML and no 401** on errors (they trigger "load as web page" with *default* settings), using 404/410 as `text/plain`; tolerate a `??token=` query in the request; and serve over publicly trusted HTTPS. |
| 2 | **No network isolation.** Chrome keeps running with its windows hidden, so **the ClassGuard extension stays online** (§8.1.6). | (a) The "extension came back online, so abandoned" rule from §4 **doesn't work on Windows**. Use "gate reported `launched`, then no finish hit by `ends_at`" instead. (b) New option: the extension can keep sending a heartbeat on Windows, so the dashboard can show "device online, in SEB since hh:mm". It can't see SEB, though. (c) The extension **must not open tabs, windows or notifications while an SEB lockdown is active on Windows**, or SEB hides them, and in the worst case kills Chrome. |
| 3 | **Google blocks sign-in from CEF-based browsers** (§8.1.8). | **Test 1 decides whether sign-in-required Forms can run in SEB on Windows.** If they can't, the options are: (a) Windows uses Forms that don't require sign-in, with identity from ClassGuard (e.g. a pre-filled field carrying the student token, validated server-side); (b) Windows students use the Chrome soft lock, like Chromebooks; (c) drop SEB on Windows. **Decision needed at review.** |
| 4 | Third-party cookies are **allowed** in CEF (§8.1.8). | The wrapper iframe can see a Google session that was established at top level. That doesn't solve sign-in, so it doesn't change the §4 choice. **Gate + direct stays the cross-platform layout.** |
| 5 | **The SEB service is off by default.** Without it Ctrl+Alt+Del still offers Task Manager, Sign out, Lock and Switch user (§8.1.1). | Configs for Windows set `sebServiceIgnore = false`, and `sebServicePolicy` = 1 for the pilot, then 2. The service must be running on every laptop (MSI auto-start). |
| 6 | **Default prohibited processes**: Teams, Zoom, Discord, Slack, Spotify, VLC, TeamViewer, mstsc, Chrome Remote Desktop host, … SEB 4.0 adds RMM agents like ScreenConnect, NinjaRMM, LogMeIn, Splashtop and Quick Assist (§8.1.4). | The student is asked to close them, and a SYSTEM agent that can't be killed **blocks the launch** or locks the session. **Inventory district agents** and emit `prohibitedProcesses` entries with `active = false` for the ones that must keep running. Chrome is not prohibited. |
| 7 | **False VM detections** on common school laptops in 3.10.1/3.10.2 (§8.1.4). | Set `allowVirtualMachine = true` in ClassGuard configs, or require SEB ≥ 3.10.3 after test 2. |
| 8 | JS API: `updateKeys(fn)` calls `fn` directly; the injection is asynchronous and sometimes missing at DOMContentLoaded (§8.1.5). | The gate page uses a **named global callback** and **polls** for `window.SafeExamBrowser` before deciding. The server Config Key computation is **shared** with Mac. |
| 9 | Quit-password hash without NFC; 3.10.3+ requires a 64-hex hash and rejects `",` in any string (§8.1.2). | ASCII-only generated quit passwords. The config generator rejects `",` in any string. |
| 10 | Single instance: a second link while SEB runs is **dropped** with a dialog (§8.1.3). | Same outcome as Mac: the extension must not retry-launch while the gate has reported `launched`. |
| 11 | One display by default; NVDA/JAWS and the touch keyboard need Disable Explorer Shell; injected input is blocked (§8.1.10). | Teacher-facing preflight text ("unplug external monitors"), plus a per-student accommodation flag that emits `killExplorerShell = true`. |
| 12 | Only one Google-related page of ours ever runs in SEB (the gate), and the quit URL works on redirects and in any frame (§8.1.7). | §4's finish-endpoint pattern (record `submitted`, then 302 to `quitURL`) should work unchanged. Test 4b confirms it. |

**Decisions to add to §6:** item 3 (Windows Google sign-in fallback), item 5 (service policy), item 6 (the district-agent allowlist), item 7 (VM policy vs. waiting for 3.10.3), and the accommodations flag (item 11).

---

### 8.3 `scripts/seb-spike/make-config.js` on Windows

**Would its configs work as-is?**
- **The `.seb` files: mostly yes.**
  - They are raw XML starting `<?xml` with no BOM, which Windows accepts (§8.1.2).
  - Double-clicking a `.seb` opens SEB, through the `.seb` ProgId.
  - All values are bool, integer, string, array or dict.
  - `hashQuitPassword` produces 64 lowercase hex characters, which passes the 3.10.3+ validator.
  - The Mac-only keys are ignored.
  - **Two exceptions:** the VM check (a false positive aborts SEB), and the service being ignored, which is SEB's default.
- **The `.link.txt` files (`sebs://application/seb;base64,…`): no.** SEB for Windows can't load an embedded config at launch (§8.1.3).

**Changes.** All of these are now in `make-config.js` (2026-09-29), except that item 5 keeps the single `2-direct-aac-filtered` name (AAC on Mac, kiosk mode on Windows). `probe.html` also now polls for the API for up to 5 s, shows whether it was present at load (test 0c), and shows the `token` that arrived (test 3f).

1. **Hosted links.** Add `--host-base <https URL of a directory where the .seb files will be served>`. For each variant also write `<variant>.hosted-link.txt` containing `sebs://<host-base-without-scheme>/<variant>.seb`. Also emit `<variant>.hosted-link-token.txt` with `…/<variant>.seb??token=spike123` for the query-parameter test. Keep the base64 links for the Mac tests.
2. **Windows keys in `baseConfig`.** Behind `--platform win|mac|both`, default `both`: extra keys are harmless on the other platform, and the Config Key covers whatever the file contains.
   ```js
   // Windows (SEB 3.10.x) – ignored by SEB for macOS
   createNewDesktop: true,          // kiosk mode (SecurityDataMapper.cs L131-150)
   killExplorerShell: false,
   sebServiceIgnore: false,         // default true = service not used (DataValues.cs L292)
   sebServicePolicy: 1,             // 1 = warn if the service is missing (ServiceDataMapper.cs L183-192)
   allowVirtualMachine: args['allow-vm'] === 'true',   // 3.10.1/3.10.2 false positives (GH#1517)
   allowDownloads: false,           // Windows default true (DataValues.cs L173)
   allowUploads: false,             // Windows default false; Forms file-upload needs true
   enableChromeNotifications: true, // don't let the service rewrite Chrome's notification policy
   ```
   Also pass `quitURLConfirm: false` explicitly. It already is; keep it, because the defaults differ (Windows false, Mac true).
3. **The query-parameter variant.** Add `startURLAppendQueryParameter: true` to the probe variant, so the probe page shows the `token` that arrived.
4. **Windows UA variant for test 1c.** Emit `1c-signin-custom-ua-win` with `browserUserAgentWinDesktopMode: 1` and `browserUserAgentWinDesktopModeCustom: <current stable Chrome for Windows UA>`. Label it "diagnostic only": SEB still appends `SEB/x.y`, and Google forbids UA spoofing (GOOG-2020).
5. **Variant naming.** `2-direct-aac-filtered` has AAC in its name, but on Windows it is the kiosk variant. Emit it once and describe it as "AAC on Mac, kiosk on Windows", or add an alias `2w-direct-kiosk-filtered` with the same content.
6. **Guards.**
   - Reject non-ASCII `--quit-password` (no NFC on Windows).
   - Reject any string containing `",` (3.10.3+ validator).
   - Never emit `originatorVersion`, empty dicts or `<real>`/`<date>`/`<data>` (Config Key parity, `Json.cs#L41-44`). The current code already doesn't.
7. **Optional: `--deactivate-prohibited name1.exe,name2.exe`.** It emits `prohibitedProcesses: [{active:false, executable, originalName, os:1, description:'district agent'}]` for district agents found during the pilot (§8.1.4).
8. **Comments.** Update the header comment. The base64 link is **macOS only**, and Windows needs the hosted form. Cite `NetworkResourceLoader.cs#L133-146` and `CompositionRoot.cs#L228-230` at `397f8e12`.

---

### 8.4 Layout on Windows (§3/§4 recheck)

| | Direct | Wrapper | Gate + direct |
|---|---|---|---|
| Google sign-in | top-level, but **CEF sign-in is expected to be blocked** (test 1) | sign-in can't happen in the frame (XFO DENY); works only after a prior top-level sign-in, since 3PC is allowed | same as Direct |
| Verify real SEB with our config | no | JS API | JS API, **with polling** |
| Heartbeat while answering | none from SEB, **but the ClassGuard extension stays online** | wrapper plus extension | extension only |
| Submitted, then quit | – | Finish link (the quit URL fires in any frame) | finish endpoint, then 302 to `quitURL` |

**Gate + direct stays the recommendation for both platforms.** Whether Windows can use SEB at all for sign-in-required Forms depends on test 1.

---

### 8.5 Hands-on tests (Windows test PC)

#### Setup
1. Use a district-image Windows 11 laptop, the fleet model, with the district EDR and a **standard student account**. Record the Windows build, model, CPU and whether it is ARM.
2. Install as admin:
   - the VC++ 2015–2022 x64 redistributable;
   - `SEB_3.10.2.920_x64_Setup.msi` via `msiexec /i … /qn`. DL publishes a SHA-1 (`4a469df8…`) only next to the SetupBundle link, so verify the bundle if you use it; for the MSI, check the Authenticode signature.
   - Confirm that the `SafeExamBrowser` service is running (`sc query SafeExamBrowser`).
   - Record whether SEB 3.10.3 is out by then; if so, repeat test 2 on it.
3. Use the same test Google Form as §5 (Verified email, Limit to 1 response, locked mode off, confirmation-message link).
4. Generate the configs, adding `--host-base https://<classguard-domain>/seb-spike/cfg/` (plus `--allow-vm true` if SEB refuses to start on the fleet model):
   ```
   node scripts/seb-spike/make-config.js \
     --form 'https://docs.google.com/forms/d/e/<FORM_ID>/viewform' \
     --origin 'https://<classguard-domain>' \
     --host-base 'https://<classguard-domain>/seb-spike/cfg/' \
     --quit-password '<ASCII test password>' \
     --out seb-spike-out
   ```
   Then serve them without deploying this draft branch: on the node that currently holds the VIP, copy the files into the running frontend container. The ClassGuard frontend serves `.seb` as `application/octet-stream`, which SEB for Windows accepts.
   ```
   docker exec classguard-frontend mkdir -p /usr/share/nginx/html/seb-spike/cfg
   docker cp seb-spike-out/. classguard-frontend:/usr/share/nginx/html/seb-spike/cfg/
   docker cp frontend/public/seb-spike/probe.html   classguard-frontend:/usr/share/nginx/html/seb-spike/
   docker cp frontend/public/seb-spike/wrapper.html classguard-frontend:/usr/share/nginx/html/seb-spike/
   ```
   These copies disappear on the next frontend redeploy. Only request files that exist: the SPA answers a missing path with `index.html` (`text/html`, 200), which SEB for Windows would load as a web page with default settings (§8.1.3).
5. Logs are in `%LocalAppData%\SafeExamBrowser\Logs`. Debug is the default level, so nothing needs switching on.

#### Test 0: install, probe, cross-platform Config Key
- **0a. Probe.** Open `0-probe.seb` by double-click. **Pass:**
  - "SafeExamBrowser API: present", reached with polling;
  - `SafeExamBrowser.version` starts with `SEB_Windows_3.10.2`;
  - a CK hash is shown;
  - the UA contains `SEB/3.10.2`.
- **0b.** Run the same probe variant on the test Mac. **Pass:** the Windows and Mac `configKey` values are **identical for the identical URL**. This proves a single server-side Config Key.
- **0c.** Reload the probe 10 times. Record how often the API is missing at DOMContentLoaded (GH#1443).
- **0d.** `updateKeys(cgKeysReady)` with a named global function calls it on both platforms.

#### Test 1: Google sign-in in SEB for Windows (gating)
- **1a.** `1a-signin-nofilter.seb`: sign in as a test-OU student, answer and submit. **Pass:** no "Couldn't sign you in / This browser or app may not be secure", and the submission shows the verified email. Screenshot any block page.
- **1b.** `2-direct-…-filtered.seb`: repeat. Collect the blocked URLs from `*_Browser.log`. That list becomes the Windows allowlist; compare it with the Mac list.
- **1c.** Only if 1a fails: `1c-signin-custom-ua-win.seb`. **Diagnostic only**; don't ship a spoofed UA.
- **1d.** If the district uses a SAML IdP, repeat 1a through it.

#### Test 2: kiosk lockdown
With the filtered config running (service on, `sebServicePolicy = 1`):

| Action | Expected |
|---|---|
| Alt+Tab, Win key, Win+D, Win+Tab, Ctrl+Esc | blocked |
| Alt+F4 on the SEB window | blocked |
| PrintScreen, Win+Shift+S, Snipping Tool | blocked, or the SEB window is excluded from the capture |
| Ctrl+Alt+Del | Task Manager, Lock, Sign out and Switch user **missing** (service on); **repeat with `sebServiceIgnore = true`** and record what's available and what Task Manager shows |
| Notifications / toasts (Teams, Chrome) | not visible |
| Copy text from before the session and paste into the Form | not pasted (isolated clipboard) |
| **ClassGuard extension** | **still heartbeating** (server log) the whole time; Chrome **not killed** |
| Extension opens a tab (trigger a policy update) | Chrome window hidden; record whether Chrome survives |
| Teams / Zoom / Spotify running before launch | SEB asks to close them; record the dialog |
| Each district agent (RMM, MDM, classroom tool) | record whether SEB lists or kills it |
| External monitor plugged in before / during | start refused / record behaviour |
| Lid close, then reopen with Windows Hello | record: SEB lock screen? password needed? |
| Touch keyboard on a 2-in-1 (Create New Desktop, then Disable Explorer Shell) | record whether typing works (injected-input block) |
| VM detection | record the message if SEB refuses to start; retry with `--allow-vm true` |

#### Test 3: launch from Chrome on Windows
- **3a. Typed.** Paste the `…hosted-link.txt` URL into Chrome. Record the prompt text ("Open …?") and whether SEB launches.
- **3b. Extension-initiated.** In the extension service worker console: `chrome.runtime.getPlatformInfo()` → `os: 'win'`, then `chrome.tabs.update({url: '<hosted link>'})`. Record the prompt and whether SEB launches.
- **3c. Test-OU URLAllowlist `sebs://*`.** Repeat 3b. **Pass:** no prompt.
- **3d. Second launch.** While SEB is running, fire 3b again. Expected: no second SEB, no visible dialog for the student. Record where the "one instance" box appears.
- **3e. Error responses.** Point links at URLs returning 404, 410, **200 `text/html`** and **401**. Expected: 404/410 give a SEB error dialog and SEB quits; HTML/401 load as a web page with default settings, which must never happen in production. Record the server access log (HEAD + GET count).
- **3f. Token.** Use `…hosted-link-token.txt` with the probe. **Pass:** the probe shows `token=spike123`, and the CK hash still verifies server-side for the full URL.
- **3g. Base64 link (negative control).** Paste a `.link.txt`. Expected: SEB error "not supported". This confirms that §8.2 #1 is real.

#### Test 4: quitting
- **4a. Quit link** in the Form's confirmation message. Record whether Google wraps it through `www.google.com/url?q=`, the exact URL chain (Browser log), and that SEB quits with no password prompt.
- **4b. 302 to the quit URL** from an HTTPS endpoint. **Pass:** SEB quits.
- **4c. Force-quit attempts:** Ctrl+Shift+Esc, Ctrl+Alt+Del → Task Manager (service on and off), `taskkill` from another admin session if available. Record.
- **4d. Reboot mid-session** (hold power). Reopen the **same** hosted link. **Pass:** the red "last session … not terminated properly" lock, cleared by the quit password. Also record the Ctrl+Alt+Del options after reboot and before reopening (registry restored?).
- **4e. Reload:** F5 on the confirmation page and on a half-filled Form. Record the reload warning and any resubmission.

#### Test 5: wrapper vs direct (Windows)
- **5a.** `5-wrapper.seb` with a sign-in-required Form, **without** a prior top-level sign-in. Expected: can't sign in within the frame.
- **5b.** Same, but first sign in top-level in the same SEB session (direct variant, then navigate to the wrapper). Record whether the Form in the iframe sees the session (3PC allowed).
- **5c.** A Form that doesn't require sign-in in the iframe: loads and submits?
- **5d.** The "Finish" link inside the wrapper quits SEB.

#### Test 6: Google Forms locked mode on Windows
Locked mode on: open the Form in Chrome on Windows and in SEB (`1a`). Record the exact messages.

#### Results

| Test | Result | Notes |
|---|---|---|
| 0 install (msiexec /qn, service running) | | |
| 0a probe (API, version, CK, UA) | | |
| 0b CK identical to Mac | | |
| 0c API missing at DOMContentLoaded (n/10) | | |
| 0d named-callback updateKeys | | |
| 1a sign-in, no filter | | |
| 1b sign-in, filtered (blocked-URL list) | | |
| 1c custom UA (diagnostic) | | |
| 1d SAML IdP | | |
| 2 kiosk checklist | | |
| 2 extension stays online | | |
| 2 district agents / prohibited list | | |
| 2 VM detection on fleet model | | |
| 2 touch keyboard / accessibility | | |
| 3a typed hosted link | | |
| 3b extension link (`os: 'win'`) | | |
| 3c URLAllowlist `sebs://*` | | |
| 3d second launch | | |
| 3e error responses (404/410/HTML/401; request count) | | |
| 3f `??token=` | | |
| 3g base64 link fails | | |
| 4a quit link | | |
| 4b 302 to quit URL | | |
| 4c force quit | | |
| 4d reboot / session-integrity lock | | |
| 4e reload | | |
| 5a wrapper, no prior sign-in | | |
| 5b wrapper after top-level sign-in | | |
| 5c wrapper, open form | | |
| 5d wrapper Finish | | |
| 6 locked mode on Windows | | |

### 8.6 Could not verify from sources (needs the test PC)
- Whether Google sign-in currently succeeds in SEB 3.10.2 (tests 1a/1d). Google's documents say CEF is blocked; SEB user reports from 2021–2022 suggest it once worked.
- Which desktop SEB's second-instance message and Chrome's hidden windows live on, and whether Chrome survives a failed hide.
- The Windows touch keyboard vs. the injected-input block; lid close with the service on.
- What Task Manager shows from Ctrl+Alt+Del without the service while SEB owns a new desktop.
- VM-detection behaviour on the district's laptop model (3.10.2 vs. 3.10.3).
- Whether Windows adds any UI of its own when Chrome's `ShellExecuteA` launches `sebs:`; the exact app name in Chrome's prompt.
- The exact `Windows NT x.y` value and the Sec-CH-UA client hints SEB sends.
