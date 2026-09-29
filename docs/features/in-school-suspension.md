# In-School Suspension (ISS): feature spec

**Status:** draft for review (2026-09-29). Nothing is built yet. Phase 1 starts after review, and after 0.17.12 (PR #303) is deployed, since it builds on that release's Penalty Box changes.

## 1. Goal

A school's ISS supervisor takes students out of their regular classes, for anything from a one-hour cool-down to several days. They need to:
- supervise those students' devices from one place, with the same tools a teacher has in Active Lesson;
- decide what each student can reach;
- get coursework from the students' regular teachers, who are usually in another part of the building, without those teachers taking over the student's device.

ISS is built as a special kind of roster rather than a separate system. Everything Active Lesson already does (Live View, Show Screens, Lock, Chat, Open URL, Lockdown Test) works in the ISS Room because the supervisor "owns" the students placed with them.

## 2. Decisions so far

| Question | Decision |
|---|---|
| Who supervises | A new **ISS Supervisor** role, switched on for individual teachers by an admin, as needed. |
| Who can place a student | ISS supervisors and admins only. Regular teachers ask in person or through the office. |
| Placement length | Flexible: from a short cool-down (e.g. 30 min or 1 hour) to "until a date". |
| How strict | The supervisor picks per placement: **Restricted** (only allowed sites) or **Monitored** (normal school filtering, just supervised). |
| What a Restricted student can reach | The admin **ISS baseline** list, sites the supervisor **grants directly**, and **coursework** the supervisor approves. |
| Coursework from regular teachers | Arrives in a **queue** the supervisor approves, holds or declines. It never goes straight to the student. |
| Delivery | Each coursework item either **opens a link in a new tab** on the student's device, or **just allows its sites**. An item can carry several sites (e.g. "read this article, write it up in a Google Doc, submit in Classroom"). |
| Regular teachers during a placement | **See only**: an "In ISS" badge, plus the ability to send coursework and talk to the supervisor. Their lock, restrict, lockdown, open/close-tab controls are off for that student until the placement ends. |
| Communication | A **staff-only thread** per placement, between the supervisor and the student's regular teachers. |
| Tests | A regular teacher sends a test as a queue item; the supervisor starts it as a Lockdown Test when the student is ready. |

## 3. Roles and permissions

- **ISS Supervisor** is a capability on a *teacher* account (`users.iss_supervisor`, boolean), set by an admin with the `users` permission on the **Users** page. It is not a separate login role: the person keeps their own classes as well.
  - Admin-tier custom roles get a new permission key `iss` ("In-School Suspension") in the permission catalog, so an admin role can be allowed or denied ISS management like any other area. Superadmins always have it.
- **What the capability grants:**
  - the **ISS Room** page and nav entry;
  - placing **any student in the district** (district-wide search). School scoping is an open question (§11);
  - full Active Lesson controls over students with an active placement they can see;
  - granting sites and deciding coursework for those students.
- **All ISS supervisors see all active placements.** Supervision often changes hands between periods or when someone is absent, so any ISS supervisor can pick up any placement. Each placement still records who placed the student and who made each decision.
- **Scoping rule** (extends the #303 rule "teachers act only on students on their rosters"): a teacher may act on a student if the student is on one of their rosters **and not in an active ISS placement**, or if they are an ISS supervisor and the student **is** in one.

## 4. Placements

**Placing a student.** From the ISS Room, **Place student**:
- **Student:** search by name or email across the district.
- **Mode:** **Restricted** or **Monitored**. The default is Restricted; the supervisor can switch mid-placement.
- **Length:** **30 min**, **1 hour**, **Rest of period** (from the student's bell schedule, when one resolves), **Rest of day** (the last period's end, or 4 pm when no schedule resolves), **Until…** (a date and time), or **Until I end it**.
- **Reason / notes:** optional, private. Visible only to ISS supervisors and admins, never to regular teachers or the student.

**While placed:**
- The supervisor can **Extend**, **Change mode** or **End now**.
- Only one active placement per student; placing an already-placed student offers to extend the existing one instead.

**Ending.** A placement ends when the supervisor ends it or its end time passes (the scheduler checks every minute, as for Lockdown Tests). Ending:
- lifts the ISS restriction (policy invalidated, device notified), and unlocks the screen if the supervisor locked it;
- marks unanswered coursework **expired** (the sending teacher sees that);
- makes the staff thread read-only; it is kept for the record;
- gives regular teachers their controls back.

**Existing restrictions.** A student already in **Penalty Box** can be placed; the Penalty Box still wins while it's active (§6). A student in a running **Lockdown Test** is placed normally, and the test carries on.

## 5. What a student can reach

For a **Restricted** placement, everything is blocked except the union of:

1. **Google sign-in** (`accounts.google.com`, `oauth2.googleapis.com`), as in Penalty Box, so the student stays signed in.
2. **ISS baseline:** a district-wide list admins set in **Settings** (e.g. `classroom.google.com`, `docs.google.com`, `drive.google.com`). Always allowed, never queued.
3. **Supervisor grants:** sites the supervisor adds for this student, for this placement, instantly.
4. **Approved coursework:** every site on every approved coursework item for this placement.

A **Monitored** placement doesn't change filtering. The student has their normal school policy, and coursework items are used only for their **Open in a new tab** delivery.

The student's block page says access is limited during ISS, and that coursework appears once the supervisor approves it. It shows no reason and no names.

## 6. Enforcement and precedence

**Precedence** (highest first):
1. Lockdown Test
2. Penalty Box
3. **ISS placement (Restricted)**
4. Focus class session
5. The student's normal policy (Monitored ISS placements fall through to here)

**Backend.**
- `resolvePolicy()` gets a new `mode: 'iss'` step between Penalty Box and the lesson step.
- `resolvedAllowDomains` is the §5 union.
- The policy result carries `issPlacementId` and `issAllowDomains`, so the extension can show the ISS block page and allow exactly those sites.
- `explainPolicyChain()` gets the matching tier, so the Filter Simulator shows it.

**DNS.** The DNS engine honors identity-aware modes only for `lesson` and `penalty_box` today (`dns-engine/src/resolver.js`). `iss` is added to that list, with the same block-everything-but-the-allow-list behavior, and logs with `blockReason: 'iss'`.

**Extension** (new version):
- `rules.js` adds an `iss` mode: block all, allow the ISS allow list plus Google sign-in, and send blocked pages to `blocked.html?reason=iss`.
- **Open in a new tab** coursework reuses the existing `teacher:open_tab_request` path, sent when the supervisor approves.

**Regular teachers' controls** (see-only). The remote-command and restriction endpoints return **409 "Student is in ISS"** for a regular teacher while the student is placed. Admins and ISS supervisors are unaffected. The affected endpoints:
- `/extension/lock-request`, `/extension/unlock-request`, `/extension/close-tab-request`;
- `/penalty-box`, `/lockdown`.

`/extension/open-tab-request` is different: for a regular teacher it **doesn't fail, it becomes a coursework item** (§7). The teacher sees "Sent to the ISS supervisor for approval".

## 7. Coursework queue

**Sending coursework.** A regular teacher sees **Send coursework** on the student's card while they're **In ISS**. Using **Open URL** or **Open Tab** on that student does the same thing, pre-filled.
- **Title:** e.g. "Ch. 5 reading + summary".
- **Open link (optional):** a URL to open on the student's device.
- **Sites to allow:** one or more domains. Pre-filled from the open link's domain; the teacher can add more (e.g. the article's site plus Docs and Classroom). Sites already on the ISS baseline are shown as "always allowed" and don't need adding.
- **Delivery:**
  - **Open in a new tab**: needs an open link. On approval the link opens on the student's device and all listed sites are allowed.
  - **Just allow the sites**: on approval the sites are allowed, and the student opens them when they get to it (e.g. from Classroom).
- **Note to the ISS supervisor (optional).**
- **This is a test:** see §9.

**Focus sessions.** When one of the student's regular classes starts or changes a **Focus** session, that session's allowed sites arrive as one item: "\<class\>: Focus sites", delivery **Just allow the sites**. A later change updates the same item, and it's marked expired when the session ends.

**The supervisor's queue**, per student in the ISS Room, newest first:
- **Approve.** The supervisor can first edit the sites and switch the delivery mode (e.g. change **Open in a new tab** to **Just allow** if the student is mid-task). The sites are allowed for the rest of the placement.
- **Hold.** Stays in the queue, marked held, optionally with a note (e.g. "finishing History first"). Can be approved later.
- **Decline**, with a short reason the teacher sees.
- **Discuss.** Opens the staff thread with the item quoted (§8).
- **Open again.** For an approved **Open in a new tab** item, reopens the link on the student's device.
- **Revoke.** Removes an approved item's sites from the allow list; other items or grants may still allow the same site.
- **Auto-approve from \<teacher\>**, per placement: items from that teacher are approved on arrival, still logged, and still visible in the queue.

**The teacher's view.** Each item's status (waiting, held, approved, declined, expired) shows on the student's card and in the item list, with the supervisor's note. Status changes arrive live.

## 8. Staff thread

- Created with the placement. Members: the ISS supervisors who act on it (added as they do), and every regular teacher of the student's classes, added when they first send an item or open the thread. **The student is never a member**, and staff threads are never sent to student devices.
- It builds on the existing chat, with a new thread type `staff`. `chat_thread_members.role` gains `staff`. The thread links to the placement (`chat_threads.iss_placement_id`).
- **Discuss** on a queue item posts a quoted reference to the item.
- Supervisors see it in the ISS Room; teachers see it from the student's card ("Messages with ISS"). New messages notify live, like existing chat.
- When the placement ends it becomes read-only (`archived_at`). It's kept and visible in **Chat Audit** like other threads.

## 9. Tests

- In **Send coursework**, **This is a test** asks for the test link (e.g. a Google Form), a time limit (optional), and notes (e.g. accommodations).
- The item waits in the queue until the supervisor clicks **Start test** when the student is ready. That starts a normal **Lockdown Test** on the student's device (it outranks the ISS restriction), linked to the item.
- Test events (started, attempts to leave the test, ended) go to the supervisor's ISS Room **and** the requesting teacher's view of the student. Lockdown events are sent to the class room today (`class:<id>`), so they also need routing to both teachers.
- When the Lockdown Test ends, the item is marked **Test finished**. Retakes or rescheduling are agreed in the thread.
- Once the Safe Exam Browser work lands, a test on a Mac or Windows device follows the same flow with that lock type.

## 10. Data model (new migration)

```
users.iss_supervisor              BOOLEAN NOT NULL DEFAULT false

iss_placements
  id, student_id, placed_by, mode ('restricted'|'monitored'),
  starts_at, ends_at (NULL = until ended), ended_at, ended_by,
  notes (private), created_at, updated_at
  UNIQUE (student_id) WHERE ended_at IS NULL

iss_site_grants                    -- supervisor grants (§5 item 3)
  id, placement_id, domain, granted_by, created_at, revoked_at

iss_coursework_items
  id, placement_id, sent_by, class_id (NULL for manual),
  source ('teacher'|'focus_session'|'open_tab'),
  lesson_session_id (for focus_session items),
  kind ('coursework'|'test'), title, note,
  open_url, sites JSONB (domains), delivery ('open_tab'|'allow_only'),
  test_duration_minutes, lockdown_session_id,
  status ('pending'|'held'|'approved'|'declined'|'expired'|'test_finished'),
  decided_by, decided_at, decision_note, created_at, updated_at

iss_auto_approve                   -- per placement, per teacher
  placement_id, teacher_id, created_by, created_at

settings key 'iss_baseline_domains' (JSON array)
chat_threads: type adds 'staff'; iss_placement_id UUID NULL
chat_thread_members.role adds 'staff'
lockdown_sessions.iss_item_id UUID NULL
```

Every placement change and queue decision is also written to `teacher_actions`, for the audit trail and reports.

## 11. Open questions

1. **School scoping.** Can an ISS supervisor place students from any school in the district, or only their own building(s)? The design starts district-wide; scoping by building would need a building attribute on students and staff, which ClassGuard doesn't track reliably today.
2. **Visibility for other staff.** Should counselors or front-office admins see who is in ISS (read-only)? The design allows admins only.
3. **Notifications.** Should a regular teacher be told when their student is placed or released (live toast, email)? The design uses the live "In ISS" badge only.
4. **Rest-of-day fallback.** Is 4 pm right when no bell schedule resolves for a student?
5. **Monitored mode and coursework.** In Monitored mode the student already has normal filtering, so "Just allow the sites" items change nothing. Should those skip the queue and just notify the supervisor?
6. **Records.** Should placements appear in **Reports** (e.g. ISS minutes per student per term)? That data is sensitive, so it would be admin-only.

## 12. Build phases (one PR each, plus Help articles)

1. **Role and placements:**
   - the `iss_supervisor` flag and `iss` permission;
   - placements with Restricted and Monitored modes, and durations including cool-downs;
   - the ISS Room page (roster of active placements with the Active Lesson tools);
   - the baseline list and supervisor grants;
   - `iss` mode in the resolver, DNS and extension;
   - see-only controls for regular teachers and the "In ISS" badge.
2. **Coursework queue:**
   - Send coursework, with multi-site items and both delivery options;
   - Open URL / Open Tab turned into queue items;
   - Focus-session items;
   - approve, hold, decline, revoke and auto-approve;
   - live status for teachers.
3. **Staff thread:** the `staff` thread type, Discuss from items, the teacher and supervisor views, archiving at placement end.
4. **Tests:** test items, Start test as a Lockdown Test, and event routing to both teachers.

Phase 1 is useful on its own (cool-downs, supervision, direct grants). Phases 2–4 add the link with regular teachers.
