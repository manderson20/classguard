# In-School Suspension (ISS): feature spec

**Status:** draft for review (2026-09-29; §3 and §11 updated after the first review). Nothing is built yet. Phase 1 starts after review, and after 0.17.12 (PR #303) is deployed, since it builds on that release's Penalty Box changes.

## 1. Goal

A school takes students out of their regular classes into In-School Suspension, for anything from a one-hour cool-down to several days. The ISS staff running a room need to:
- supervise those students' devices from one place, with the same tools a teacher has in Active Lesson;
- decide what each student can reach;
- get coursework from the students' regular teachers, who are usually in another part of the building, without those teachers taking over the student's device.

Larger districts run several ISS rooms, each led by its own ISS instructor, with an ISS supervisor overseeing all of them. In a small school one person does both.

ISS is built as a special kind of roster rather than a separate system. Everything Active Lesson already does (Live View, Show Screens, Lock, Chat, Open URL, Lockdown Test) works in an ISS room because its instructor "owns" the students placed in it.

## 2. Decisions so far

| Question | Decision |
|---|---|
| ISS roles | Permission-based ISS roles assigned to staff as needed, each **scoped to one or more schools**. Built-in templates: **ISS Viewer**, **ISS Instructor** (runs ISS groups/rooms), **ISS Supervisor** (oversees every group in their schools). Districts can edit them or create their own. One person can hold several. |
| Schools | Learned from roster sync. A superadmin can scope any role assignment to several schools. |
| Who can place a student | Whoever holds the **Place students** permission. District-wide, the district decides which roles get it (e.g. building administration and ISS staff in a small school). Regular teachers never can. |
| Placement length | Flexible: from a short cool-down (e.g. 30 min or 1 hour) to "until a date". |
| How strict | ISS staff pick per placement: **Restricted** (only allowed sites) or **Monitored** (normal school filtering, just supervised). |
| What a Restricted student can reach | The admin **ISS baseline** list, sites ISS staff **grant directly**, and **coursework** ISS staff approve. |
| Coursework from regular teachers | Sent as an **assignment package**: instructions, links, sites to allow, and **files** (worksheets, presentations, PDFs, images). Arrives in a **queue** ISS staff approve, hold or decline; it never goes straight to the student. The teacher and ISS staff effectively co-teach it. |
| Delivery | Each package either **opens a link in a new tab** on the student's device, or **just allows its sites**. It can carry several sites (e.g. "read this article, write it up in a Google Doc, submit in Classroom"). Files are printed by ISS staff or shared to the student's **My ISS work** page. |
| Google Classroom | A **Classroom scanner** notices when a teacher posts in Google Classroom for a course with a student currently in ISS, turns the post into a draft package, and **prompts the teacher** to send it to ISS (§7a). |
| Work to do | Every package lands on the student's **Work to do** list, which ISS staff see and tick off. The teacher sees each item's progress. |
| Regular teachers during a placement | **See only**: an "In ISS" badge, plus the ability to send coursework and talk to ISS staff. Their lock, restrict, lockdown, open/close-tab controls are off for that student until the placement ends. |
| Communication | A **staff-only thread** per placement, between ISS staff and the student's regular teachers. |
| Tests | A regular teacher sends a test as a queue item; ISS staff start it as a Lockdown Test when the student is ready. |

## 3. Roles, groups, schools and permissions

**Schools.** ISS access is scoped by school, and the schools come from roster sync:
- **OneRoster** (e.g. Infinite Campus, PowerSchool) already tags each class and user with its school ("org"). Roster sync gains a `schools` table plus school links for classes and users. Today it only fetches orgs to test the connection.
- **Google-only districts** map Google OU paths to schools in Settings (e.g. `/Students/High School` → High School).
- A student's school is the one roster sync gives them. Staff belong to the schools of the classes they teach, plus any schools an admin adds.

**ISS groups.** An ISS group is one ISS room: a name (e.g. "ISS — High School, Room 104"), the **school(s)** it serves, one or more instructors, and the students currently placed in it. A district with one ISS room has one group.

**ISS permissions.** Every ISS ability is a separate permission. A role holds any set of them.

| Permission | Allows |
|---|---|
| `iss.view` | Read-only view of who is placed in which group, until when (no notes, no queues). For counselors or office staff, if a district wants that. |
| `iss.instruct` | Running the groups they're assigned to: full Active Lesson controls, direct site grants, coursework decisions, starting tests, the staff threads. |
| `iss.place` | Placing students, and extending, changing mode or ending placements, within the groups they can act on. |
| `iss.supervise` | Everything above for **every** group in their schools: the overview of all groups, covering any group, moving students between groups, creating and archiving groups, assigning instructors. |
| `iss.reports` | ISS reports (e.g. placements and time in ISS per student, per school, per term). Sensitive, so it's separate from the other permissions. |

**Roles.** An ISS role is a named set of those permissions. ClassGuard ships three editable templates; districts can change them or add their own (e.g. "Building Administrator" = place + supervise + reports).

| Template | Permissions |
|---|---|
| **ISS Viewer** | `iss.view` |
| **ISS Instructor** | `iss.instruct`, and `iss.place` if the district allows instructors to place (district setting, §4) |
| **ISS Supervisor** | `iss.view`, `iss.instruct`, `iss.place`, `iss.supervise` |

**Assignments.** An admin assigns an ISS role to a staff member **for one or more schools** on the **Users** page. The school choices are those learned from roster sync.
- **Superadmins** can assign any school combination (e.g. a district-level supervisor over three buildings).
- Admins with the `iss` admin permission can assign within their own schools.
- One person can hold several assignments (e.g. Instructor at the middle school, Supervisor at the high school). A small school can give one person the Supervisor role for its single school.

**What scoping means:**
- ISS staff only see, search for and place **students of their assigned schools**, and only see **groups serving those schools**.
- Placement search, the supervisor overview, reports and read-only views are all filtered by school.
- An instructor acts on the groups they're assigned to; a supervisor acts on every group in their schools.

- **"ISS staff"** below means anyone with `iss.instruct` on the placement's group, plus supervisors of its school.
- **Hand-offs.** A group can have several instructors, and a supervisor can step into any group in their schools. Each placement records who placed the student, and each decision records who made it.
- **Admins** keep full access through the admin permission `iss` in the custom-role permission catalog (school-limited like other admin areas once schools exist). Superadmins always have it.
- **Scoping rule** (extends the #303 rule "teachers act only on students on their rosters"). A teacher may act on a student if either:
  - the student is on one of their rosters **and not in an active ISS placement**; or
  - they hold `iss.instruct` on the student's current ISS group, or `iss.supervise` for its school.

## 4. Placements

**Who can place.** Holders of `iss.place`. A district setting, **Instructors can place students**, decides whether the ISS Instructor template includes it: on in a district where the ISS instructor handles referrals, off where only building administration places students after a discipline event.

**Placing a student.** From an ISS group's page, **Place student** (a supervisor can also place from the overview and choose the group):
- **Student:** search by name or email across the district.
- **Group:** the group the student goes to. Pre-selected when placing from a group's page.
- **Mode:** **Restricted** or **Monitored**. The default is Restricted; ISS staff can switch mid-placement.
- **Length:** **30 min**, **1 hour**, **Rest of period** (from the student's bell schedule, when one resolves), **Rest of day** (the last period's end, otherwise the district's **ISS end-of-day time** setting, default **4:00 PM**), **Until…** (a date and time), or **Until I end it**.
- **Reason / notes:** optional, private. Visible only to ISS staff with access to the placement's group (its instructors, supervisors) and admins; never to regular teachers or the student.

**While placed:**
- The group's instructors (or a supervisor) can **Extend**, **Change mode** or **End now**.
- A supervisor can **Move to another group**. The student's grants, coursework and thread go with them, and the new group's instructors take over.
- Only one active placement per student; placing an already-placed student offers to extend the existing one instead.

**Telling the student's teachers.** When a student is placed, and again when they're released, each of their regular teachers gets a live notice in ClassGuard ("\<student\> is in ISS until 2:15 PM" / "…is back from ISS"), alongside the **In ISS** badge on the student's card. The notice shows no reason. Email is a later option.

**Ending.** A placement ends when ISS staff end it or its end time passes (the scheduler checks every minute, as for Lockdown Tests). Ending:
- lifts the ISS restriction (policy invalidated, device notified), and unlocks the screen if ISS staff locked it;
- marks unanswered coursework **expired** (the sending teacher sees that);
- makes the staff thread read-only; it is kept for the record;
- gives regular teachers their controls back.

**Existing restrictions.** A student already in **Penalty Box** can be placed; the Penalty Box still wins while it's active (§6). A student in a running **Lockdown Test** is placed normally, and the test carries on.

## 5. What a student can reach

For a **Restricted** placement, everything is blocked except the union of:

1. **Google sign-in** (`accounts.google.com`, `oauth2.googleapis.com`), as in Penalty Box, so the student stays signed in, and ClassGuard's own **My ISS work** page (§7).
2. **ISS baseline:** a district-wide list admins set in **Settings** (e.g. `classroom.google.com`, `docs.google.com`, `drive.google.com`). Always allowed, never queued.
3. **Direct grants:** sites the group's instructor (or a supervisor) adds for this student, for this placement, instantly.
4. **Approved coursework:** every site on every approved coursework item for this placement.

A **Monitored** placement doesn't change filtering. The student has their normal school policy, and coursework items are used only for their **Open in a new tab** delivery.

The student's block page says access is limited during ISS, and that coursework appears once ISS staff approve it. It shows no reason and no names.

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
- **Open in a new tab** coursework reuses the existing `teacher:open_tab_request` path, sent on approval.

**Regular teachers' controls** (see-only). The remote-command and restriction endpoints return **409 "Student is in ISS"** for a regular teacher while the student is placed. Admins, ISS supervisors and the instructors of the student's ISS group are unaffected. The affected endpoints:
- `/extension/lock-request`, `/extension/unlock-request`, `/extension/close-tab-request`;
- `/penalty-box`, `/lockdown`.

`/extension/open-tab-request` is different: for a regular teacher it **doesn't fail, it becomes a coursework item** (§7). The teacher sees "Sent to ISS for approval".

## 7. Coursework: assignment packages, queue and work list

The aim is to make it as easy as possible for a regular teacher to hand ISS staff **everything an assignment needs**, so the ISS instructor can "co-teach" it and get the materials to the student.

**Sending an assignment package.** A regular teacher sees **Send assignment** on the student's card while they're **In ISS**. Using **Open URL** or **Open Tab** on that student starts the same dialog, pre-filled. A package has:
- **Title:** e.g. "Ch. 5 reading + summary".
- **Instructions for the student:** shown to the student on their **My ISS work** page.
- **Notes for ISS staff (optional):** never shown to the student (e.g. "They can use notes; collect the worksheet at the end").
- **Links:** one or more URLs. One can be marked **open on the student's device**.
- **Sites to allow:** one or more domains. Pre-filled from the links' domains; the teacher can add more (e.g. the article's site plus Docs and Classroom). Sites already on the ISS baseline are shown as "always allowed".
- **Files:** drag and drop worksheets, slide decks, PDFs and images: PDF, PNG/JPEG/GIF/WebP, Word, PowerPoint, Excel, plain text. Up to 25 MB per file and 10 files / 100 MB per package; district-adjustable.
- **Delivery:**
  - **Open in a new tab**: needs a link marked to open. On approval that link opens on the student's device and all listed sites are allowed.
  - **Just allow the sites**: on approval the sites are allowed, and the student opens them when they get to it (e.g. from Classroom).
- **When:** optional, e.g. "Today", "Before the end of the placement", or a date.
- **This is a test:** see §9.
- **Send to:** this student, or **all my students currently in ISS** (e.g. a class-wide assignment for several students placed the same day). Each student gets their own copy on their own list.

A teacher can also **Send again** a previous package to another student later, with its files.

**Focus sessions.** When one of the student's regular classes starts or changes a **Focus** session, that session's allowed sites arrive as one item: "\<class\>: Focus sites", delivery **Just allow the sites**, no files. A later change updates the same item, and it's marked expired when the session ends.

**The ISS queue**, per student on the group's page, newest first. It's handled by the group's instructors, or a supervisor. The supervisor overview shows each group's count of pending items, so a backlog in one room is visible.
- **Approve.** ISS staff can first edit the sites and links and switch the delivery mode (e.g. change **Open in a new tab** to **Just allow** if the student is mid-task). The sites are allowed for the rest of the placement, and the package moves to **Work to do**.
- **Hold.** Stays in the queue, marked held, optionally with a note (e.g. "finishing History first"). Can be approved later.
- **Decline**, with a short reason the teacher sees.
- **Discuss.** Opens the staff thread with the item quoted (§8).
- **Open again.** For an approved **Open in a new tab** item, reopens the link on the student's device.
- **Revoke.** Removes an approved item's sites from the allow list; other items or grants may still allow the same site.
- **Auto-approve from \<teacher\>**, per placement: packages from that teacher are approved on arrival, still logged, and still visible.

**Monitored placements** (decided at review, §11 #6):
- **Just allow the sites** packages skip approval. They're marked **Delivered** and go straight onto the student's **Work to do** list, so ISS staff always see what's assigned.
- **Open in a new tab** packages still wait for approval.
- Nothing overrides district filtering in Monitored mode. If a package's site is blocked by district filtering, the item says so for the teacher and ISS staff; ISS staff can switch the placement to Restricted if the site is really needed.

**Work to do**, per student on the group's page (and summarized per group on the supervisor overview):
- Every approved or delivered package, with its instructions, links, files, "when" and sending teacher.
- ISS staff mark each one **Done**, optionally with a note (e.g. "worksheet collected", "submitted in Classroom 10:40"), or **Not finished** at the end of the placement.
- The list stays with the student if they move to another group.

**Files.** For each file, ISS staff can:
- **Download or print** it (e.g. a paper worksheet);
- **Share with student**, which puts it on the student's **My ISS work** page.

Nothing is shared with the student automatically; the teacher can mark files as "share with the student" when sending, and ISS staff can change that.

**My ISS work** is a page on the student's device, hosted by ClassGuard and always reachable during a placement, even Restricted.
- It lists the student's current work: titles, **instructions for the student**, links, shared files (PDFs and images open in the browser; Office files download) and when each is due. It never shows notes for ISS staff.
- The extension opens it when a placement starts and whenever something new is shared.
- The student can't mark items done; ISS staff do.
- It's available only while a placement is active.

**The teacher's view.** Each package's status shows on the student's card and in the teacher's item list, with the ISS staff's notes, and changes arrive live:
- waiting, held, approved/delivered, declined, expired;
- then **Done** or **Not finished**.

**File handling:**
- **Storage.** Files are stored **in the database**, so they are replicated to the standby node and included in backups. Chat attachments today live on each server's local disk, which a failover doesn't carry over.
- **Serving.** Files are only served to ISS staff who can act on the placement, the sending teacher, and (for shared files) the student during the placement. Downloads use `Content-Disposition` and `X-Content-Type-Options: nosniff`, and only the listed types are accepted, checked by content as well as extension.
- **Retention.** Files are deleted a set time after the placement ends. It's a district setting, default 30 days. Package text and statuses are kept with the placement record.

## 7a. Google Classroom scanner

Most coursework is posted in Google Classroom. Rather than asking teachers to repackage it, ClassGuard watches Classroom for them and asks.

**What triggers a prompt.** A post is **published** (including a scheduled post going live) while a student is in an ISS placement, in a Classroom course that:
- is linked to a ClassGuard class (`classes.google_classroom_id`, already set by the Google Classroom roster sync); and
- has that student enrolled.

It must be assigned to the student: to all students, or to specific students including them. Covered post types:
- **assignments and questions** (`courseWork`);
- **materials** (`courseWorkMaterials`);
- **announcements** that carry materials or links.

**No ISS student, no prompt.** A teacher is **never** prompted for a post unless at least one student who is **both** assigned that post **and** currently in ISS is in that course. If nobody in the course is in ISS, the scanner doesn't even read the course. A post assigned only to other students is ignored too. When the placement ends, any unanswered prompts for that student are withdrawn.

**What the scanner reads**, and how it turns a post into a **draft assignment package**:

| In the Classroom post | In the draft package |
|---|---|
| Title | Title |
| Description / announcement text | Instructions for the student |
| Due date and time | When |
| Link materials | Links, with their sites added to **Sites to allow** |
| YouTube videos | Links; `youtube.com` added to the sites |
| Drive files and folders | Links (Docs, Drive and Classroom are usually on the ISS baseline). Optionally, **Attach a PDF copy**: Docs, Slides and Sheets are exported to PDF, and uploaded files like PDFs and images are copied into the package, so ISS staff can print them. |
| Google Forms | Links. It's flagged **"Looks like a quiz or test — send as a test?"**, which turns it into a test item (§9). |
| A link to the post in Classroom | Kept on the package for ISS staff, so they can open the original |

**Prompting the teacher.** For each new post, the teacher who posted it (and co-teachers of the course) get a **"Send to ISS?"** prompt, listing which of their students in that course are in ISS right now:
- **In ClassGuard:** a pop-up window if they have ClassGuard open, and a badge on **My Classes** until they answer.
- **On their device:** a Chrome notification from the ClassGuard extension, if the teacher's Chrome runs it. Clicking it opens the review window.

The review window shows the draft package, fully editable. The teacher can:
- **Send to ISS**, choosing which of the listed students, with files and delivery options as in §7;
- **Not needed** (e.g. an in-class activity that doesn't apply);
- **Remind me later**;
- turn on **Always send posts from this class while students are in ISS**, per class. Future posts are then sent automatically, and still go through the ISS queue.

**Catching up.** When a student is placed, each of their teachers' placement notice (§4) also lists posts from **earlier that day** in that teacher's Classroom courses. The teacher can send any of them the same way.

**How it reads Classroom.**
- It reuses the existing Google service account with domain-wide delegation, reading **as the course's teacher**, like the Classroom roster sync and ClassPulse's Slides import.
- It needs extra read-only scopes, which the district adds in the Google Admin console: coursework, coursework materials and announcements; Drive read-only, already used by ClassPulse, is needed only for PDF copies. The exact scope strings are confirmed against the API at build time.
- **Polling, not push**, to start. Every 2 minutes it checks only the courses of students **currently placed**, one request per post type per course, filtered to posts newer than the last check. With no one in ISS, it makes no calls.
  - Classroom push notifications (Cloud Pub/Sub) only cover assignments, not materials or announcements. They also need a Google Cloud project with Pub/Sub and billing. They could be added later to cut the delay.
- **Off by default.** It's a district setting, and it needs the Classroom roster sync, so that ClassGuard classes are linked to Classroom courses.

**Privacy.**
- It reads only posts in courses where a student is currently placed.
- It stores only the drafts the teacher sees, plus which posts it has already seen.
- It never reads student submissions or grades.
- Drafts the teacher dismisses are deleted after the placement ends.

## 8. Staff thread

- Created with the placement. Members:
  - the instructors of the student's ISS group (updated if the student moves group);
  - ISS supervisors, when they post or open it; supervisors can read every placement's thread;
  - every regular teacher of the student's classes, added when they first send an item or open the thread.

  **The student is never a member**, and staff threads are never sent to student devices.
- It builds on the existing chat, with a new thread type `staff`. `chat_thread_members.role` gains `staff`. The thread links to the placement (`chat_threads.iss_placement_id`).
- **Discuss** on a queue item posts a quoted reference to the item.
- ISS staff see it on the group's page; teachers see it from the student's card ("Messages with ISS"). New messages notify live, like existing chat.
- When the placement ends it becomes read-only (`archived_at`). It's kept and visible in **Chat Audit** like other threads.

## 9. Tests

- In **Send coursework**, **This is a test** asks for the test link (e.g. a Google Form), a time limit (optional), and notes (e.g. accommodations).
- The item waits in the queue until the group's instructor (or a supervisor) clicks **Start test** when the student is ready. That starts a normal **Lockdown Test** on the student's device (it outranks the ISS restriction), linked to the item.
- Test events (started, attempts to leave the test, ended) go to the ISS group's page **and** the requesting teacher's view of the student. Lockdown events are sent to the class room today (`class:<id>`), so they also need routing to both teachers.
- When the Lockdown Test ends, the item is marked **Test finished**. Retakes or rescheduling are agreed in the thread.
- Once the Safe Exam Browser work lands, a test on a Mac or Windows device follows the same flow with that lock type.

## 10. Data model (new migration)

```
schools                            -- from roster sync (OneRoster orgs of type school)
  id, name, oneroster_sourced_id, google_ou_prefixes JSONB, created_at
classes.school_id                  UUID NULL
user_schools                       -- students' and staff's schools
  user_id, school_id, source ('roster'|'manual'), PRIMARY KEY (user_id, school_id)

iss_roles                          -- templates + district-defined roles
  id, name, permissions JSONB (iss.view|iss.instruct|iss.place|iss.supervise|iss.reports),
  is_template, created_at, updated_at
iss_role_assignments
  id, user_id, role_id, created_by, created_at
iss_role_assignment_schools
  assignment_id, school_id

iss_groups
  id, name, created_by, created_at, archived_at
iss_group_schools
  group_id, school_id

iss_group_instructors
  group_id, user_id, added_by, added_at    PRIMARY KEY (group_id, user_id)

iss_placements
  id, student_id, group_id, placed_by, mode ('restricted'|'monitored'),
  starts_at, ends_at (NULL = until ended), ended_at, ended_by,
  notes (private), created_at, updated_at
  UNIQUE (student_id) WHERE ended_at IS NULL

iss_site_grants                    -- direct grants (§5 item 3)
  id, placement_id, domain, granted_by, created_at, revoked_at

iss_coursework_items               -- one assignment package for one placement
  id, placement_id, sent_by, class_id (NULL for manual),
  source ('teacher'|'focus_session'|'open_tab'), copied_from_item_id,
  lesson_session_id (for focus_session items),
  kind ('coursework'|'test'), title,
  instructions_student, notes_staff, due_hint, due_date,
  links JSONB ([{url, open_on_device}]), sites JSONB (domains),
  delivery ('open_tab'|'allow_only'),
  test_duration_minutes, lockdown_session_id,
  status ('pending'|'held'|'approved'|'delivered'|'declined'|'expired'|'test_finished'),
  decided_by, decided_at, decision_note,
  progress ('todo'|'done'|'not_finished'), progress_by, progress_at, progress_note,
  created_at, updated_at

iss_classroom_suggestions          -- scanner drafts awaiting the teacher
  id, placement_id, teacher_id, course_id (Classroom), class_id,
  post_type ('coursework'|'material'|'announcement'), post_id, post_link,
  draft JSONB (the draft package), status ('pending'|'sent'|'dismissed'|'snoozed'),
  item_id (the package created when sent), created_at, updated_at
  UNIQUE (placement_id, post_type, post_id)
iss_classroom_auto_send            -- "always send posts from this class" (per placement or standing)
  class_id, teacher_id, created_at
iss_classroom_cursor               -- last check per course and post type
  course_id, post_type, checked_at, last_update_time

iss_item_files
  id, item_id, file_name, mime_type, size_bytes, content BYTEA,
  shared_with_student BOOLEAN, uploaded_by, created_at, deleted_at

iss_auto_approve                   -- per placement, per teacher
  placement_id, teacher_id, created_by, created_at

settings keys 'iss_baseline_domains' (JSON array), 'iss_end_of_day_time' (default '16:00'),
  'iss_instructors_can_place' (boolean), 'iss_file_limits' (per-file / per-package),
  'iss_file_retention_days' (default 30), 'iss_classroom_scanner' (off by default)
chat_threads: type adds 'staff'; iss_placement_id UUID NULL
chat_thread_members.role adds 'staff'
lockdown_sessions.iss_item_id UUID NULL
```

Every placement change (including group moves), queue decision and group staffing change is also written to `teacher_actions`, for the audit trail and reports.

## 11. Review decisions and remaining questions

**Decided at review (2026-09-29):**
1. **School scoping:** schools are learned from roster sync; roles are scoped to schools; superadmins can assign several schools to one assignment (§3).
2. **Who places:** the `iss.place` permission, with a district-wide setting for whether instructors get it (§4).
3. **Read-only visibility for other staff:** the optional **ISS Viewer** role (`iss.view`), used only if a district wants it (§3).
4. **Telling regular teachers:** yes, a live notice on placement and release (§4).
5. **End of day:** a configurable setting, default 4:00 PM (§4).
6. **Coursework during a Monitored placement:** option **B**. "Just allow the sites" packages skip approval and are **Delivered** straight onto the student's **Work to do** list, which ISS staff see; "Open in a new tab" still waits for approval, and nothing overrides district filtering (§7).
7. **Reports:** a separate `iss.reports` permission, assignable to any role (§3).


**New questions from §7a (Classroom scanner):**
8. **Teacher devices.** Do teachers' Chromebooks and Chrome profiles run the ClassGuard extension? If not, the prompt is in-app only, plus the My Classes badge.
9. **Email.** Should a prompt the teacher hasn't answered within, say, 15 minutes also go by email?

**Background for #6** (kept for reference):

In a Monitored placement the student keeps normal school filtering, so a coursework item's two parts behave differently:
- **"Open in a new tab"** still does something the ISS staff should control: it pops a tab on the student's device.
- **"Just allow the sites"** usually changes nothing, because those sites are already reachable under normal filtering.

Examples:
- *Cool-down, 1 hour, Monitored.* The math teacher sends "Finish the Khan Academy practice set", **Just allow** khanacademy.org. The student can already reach it, so approving grants nothing. But the ISS instructor still wants to see the assignment, so they can tell the student what to work on.
- *Same cool-down.* The English teacher sends "Read this article", **Open in a new tab**. If it opened immediately it would interrupt whatever the student is doing, so the instructor should decide when it opens.
- *Monitored, but a site the district normally blocks.* A science teacher sends a video site the district blocks. Should approving it open that site during a *Monitored* placement? Under normal filtering it stays blocked.

Options:
- **A. Everything goes through the queue**, whatever the mode. It's consistent and ISS staff always see what's assigned, at the cost of approving things that change nothing.
- **B (chosen). In Monitored mode, "Just allow" items skip approval.** They appear in the queue as **Delivered** (a to-do list for the instructor and a record for the teacher). "Open in a new tab" items still wait for approval. Nothing overrides district blocks in Monitored mode; the teacher sees "blocked by district filtering" on the item, and ISS staff can switch the placement to Restricted if the site is really needed.
- **C. No coursework in Monitored mode**, just messages in the staff thread. Simplest, but teachers lose the status tracking.

## 12. Build phases (one PR each, plus Help articles)

0. **Schools from roster sync:**
   - OneRoster orgs of type school become `schools`, with class and user school links;
   - the Google OU → school mapping in Settings;
   - a school shown on classes and users.

   Useful beyond ISS: bell schedules, reports and admin scoping can use it later.
1. **Roles, groups and placements:**
   - ISS permissions, the three role templates, and school-scoped role assignments (superadmin can assign several schools);
   - the `iss` admin permission;
   - the district settings (instructors can place, end-of-day time, baseline sites);
   - ISS groups and their instructors;
   - placements with Restricted and Monitored modes, and durations including cool-downs;
   - an ISS group page (roster of active placements with the Active Lesson tools), and the supervisor overview of all groups, with moves between groups;
   - the baseline list and direct grants;
   - `iss` mode in the resolver, DNS and extension;
   - see-only controls for regular teachers, the "In ISS" badge, and placement and release notices;
   - the ISS Viewer read-only view.
2. **Coursework queue and work list:**
   - Send assignment (text, links, sites, both delivery options, send to several ISS students, send again);
   - Open URL / Open Tab turned into queue items;
   - Focus-session items;
   - approve, hold, decline, revoke and auto-approve;
   - Monitored-mode delivery;
   - the **Work to do** list with Done / Not finished;
   - live status for teachers.
3. **Files and My ISS work:**
   - file uploads on packages, stored in the database, with type and size checks and retention;
   - download and print for ISS staff;
   - Share with student;
   - the student's **My ISS work** page, reachable during Restricted placements.
4. **Google Classroom scanner:**
   - the extra read-only scopes and district setting;
   - polling the courses of placed students;
   - draft packages from assignments, materials and announcements, with PDF copies of Drive files and Forms flagged as tests;
   - the Send to ISS prompt (in-app pop-up, My Classes badge, extension notification);
   - Not needed, Remind me later and Always send;
   - the catch-up list at placement.
5. **Staff thread:** the `staff` thread type, Discuss from items, the teacher and ISS staff views, archiving at placement end.
6. **Tests:** test items, Start test as a Lockdown Test, and event routing to both teachers.
7. **Reports:** ISS reports behind `iss.reports`, filtered by school.

Phase 1 is useful on its own (cool-downs, supervision, direct grants). Phases 2–6 add the link with regular teachers. Everything here is a starting point: details will be refined once it's running and in use.
