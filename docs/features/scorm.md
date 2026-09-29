# SCORM support: feature spec

**Status:** draft for review (2026-09-29). Nothing is built yet.

## 1. Goal

Let a district bring SCORM e-learning modules into ClassGuard and use them wherever they're useful, as options the district turns on:

1. **Class assignments:** a teacher assigns a module to a class or to specific students.
2. **ISS assignment packages:** a module is part of the coursework sent to a student in In-School Suspension (see `in-school-suspension.md`).
3. **ClassPulse:** a module is an activity inside a ClassPulse lesson.
4. **Staff training:** modules assigned to staff (e.g. compliance or security awareness), with due dates and completion reports.

All four share **one SCORM engine**: import, storage, a player, and tracking. The four uses are thin layers on top of it.

## 2. What SCORM needs from ClassGuard

A SCORM package is a zip file:
- an `imsmanifest.xml` describing the course, its launchable parts ("SCOs") and their start files;
- the course itself, as HTML, JavaScript, media and so on.

When a learner opens it, the course looks for a JavaScript API object provided by the host, normally an LMS, in a parent window. It then calls that API to report progress:
- **SCORM 1.2:** `window.API` with `LMSInitialize`, `LMSGetValue`, `LMSSetValue`, `LMSCommit`, `LMSFinish`, and data model keys such as `cmi.core.lesson_status`, `cmi.core.score.raw`, `cmi.suspend_data`.
- **SCORM 2004:** `window.API_1484_11` with `Initialize`, `GetValue`, `SetValue`, `Commit`, `Terminate`, and keys such as `cmi.completion_status`, `cmi.success_status`, `cmi.score.scaled`, `cmi.suspend_data`, `cmi.location`.

To support it, ClassGuard has to provide that API, save what the course reports (completion, pass/fail, score, time, and the resume data that lets a learner continue later), and show the results.

**Scope:** SCORM **1.2** and **SCORM 2004** (2nd–4th editions).
- **Multi-SCO packages** get a simple table of contents: the learner picks a part.
- **SCORM 2004 sequencing and navigation rules** (the complex rules for how parts unlock) aren't enforced in the first version. Parts are freely choosable, and the package list shows a warning when a package declares sequencing rules.
- **xAPI, cmi5 and AICC** are out of scope for now.

**Runtime.** The player uses **scorm-again** (MIT licence, maintained, SCORM 1.2 and 2004; <https://github.com/jcputney/scorm-again>) for the API objects and data-model validation, instead of writing our own.

## 3. Security: SCORM content runs on its own web address

SCORM packages are third-party HTML and JavaScript, and ClassGuard can't vet what's inside. ClassGuard keeps each user's login token in the browser's `localStorage` for its own web address. Any script served from that address can read it, including an admin's token if an admin previews a module. So:

- **Package content is never served from ClassGuard's own address.** It's served from a separate **content address**, e.g. `content.<classguard-domain>`: its own hostname, with its own TLS certificate from the existing ACME setup.
  - A different port on the same hostname would also be a separate origin for `localStorage`. But cookies are shared across ports, and school networks often block unusual ports, so a separate hostname is preferred. It needs one extra DNS name.
- **The player page and the course share the content address**, because SCORM courses look for the API in a parent window on the same address.
- **The player never holds a ClassGuard login token.** It's opened with a **launch token**: short-lived, signed, and valid only for one learner, one assignment and one attempt. Its only permission is saving and loading that attempt's data through `/api/v1/scorm/runtime/*`.
- **Getting a launch token:**
  - Staff get one from ClassGuard in the normal way.
  - Students get one through the ClassGuard extension. A student-facing ClassGuard page asks the extension for the student's session, the way the ClassPulse join page already does, and exchanges it for a launch token. The student never signs in to ClassGuard separately.
- **Content headers:** a Content Security Policy limiting what the course page can frame, `X-Content-Type-Options: nosniff`, and no access to ClassGuard's API beyond the runtime endpoints.

## 4. Importing packages

**Upload:** a zip, up to a district limit (default **500 MB** per package).

**On import:**
1. **Validate the zip.** Reject path traversal (`../`), absolute paths and symlinks. Cap the file count and the uncompressed size, to guard against zip bombs.
2. **Parse `imsmanifest.xml`:**
   - detect SCORM 1.2 or 2004 and the edition;
   - read the title, the organization (table of contents) and the SCOs with their launch files;
   - read the mastery score (1.2) or scaled passing score (2004);
   - note whether sequencing rules are declared (§2).
3. **Scan for external sites.** Find the web addresses the course loads (fonts, video, analytics, vendor services), so the page can list the **external domains** the module needs. This matters when a learner is in a Focus class, Penalty Box or an ISS placement: those domains have to be allowed for the module to work (§9). It's a best-effort scan, and the teacher can add domains by hand.
4. **Store** the files (§5) and create the library entry.

**Replacing a package:** uploading a new version creates a new version of the same library entry. Attempts already started stay on their version; new attempts use the latest.

## 5. Storage

Package files must be available on both servers, so a failover doesn't break modules. They're also much larger than chat attachments or ISS files.
- **Design:** files are stored **content-addressed** (by SHA-256) in the database, split into chunks. Identical files across packages are stored once. That keeps replication to the standby and the existing backups working unchanged.
- **Trade-off:** a large library makes the database and its backups bigger. The district sets a **total SCORM storage quota** (default 20 GB), and the SCORM library page shows usage.
  - If districts outgrow that, a later step is an object store replicated between the nodes (e.g. MinIO), holding the files instead of the database. The design keeps file access behind one storage module so that swap is contained.

## 6. The package library

- **Private:** only the uploader sees the package. This is the default for teachers.
- **Shared with my school(s)** or **district**: other staff can find and assign it. It uses the schools learned from roster sync (ISS spec, Phase 0).
- Each entry shows the title, SCORM version, parts, size, external domains, version history, who uploaded it and where it's used.
- **Preview:** staff can try a module without it counting as an attempt.
- **Permissions:**
  - teachers can upload privately (district setting, on by default);
  - `scorm.library` shares to school or district and removes others' packages;
  - `scorm.training` assigns to staff and sees training reports;
  - `scorm.reports` sees all SCORM reports in their schools.

## 7. Attempts and tracking

Each learner has **attempts** per assignment:
- the district or the assigning teacher sets the maximum;
- resuming continues the current attempt from its saved position;
- **Start over** begins a new attempt, if allowed.

**Recorded per attempt:**
- status (not started, incomplete, completed, passed, failed);
- score (raw, and scaled where given);
- total time, and the last saved position and resume data;
- started, last-activity and finished times;
- the full data-model values, for troubleshooting.

**Saving.** The player sends updates on every `Commit`, and also periodically and when the page closes. So a closed lid or tab loses at most the last few seconds. The course's own resume data then puts the learner back where they were.

## 8. The four uses

### 8.1 Class assignments
- A teacher picks a package (or uploads one) and assigns it to a class or to selected students, with an optional due date, attempt limit and "counts as done when": **completed**, **passed**, or **any**.
- **Students open it from:**
  - a **My assignments** page, reached from the ClassGuard extension's popup; or
  - a link the teacher posts in Google Classroom, which opens the same page on the student's device and hands over the student's session from the extension.
- **Teacher report:** per student, status, score, time spent, attempts and last activity. It can be exported as CSV.
- **Later, needs investigation:** sending scores back to Google Classroom. The Classroom API only lets an app grade coursework that the same app created, so ClassGuard would have to create the Classroom assignment itself.

### 8.2 ISS assignment packages
- A package item can include a SCORM module. The student opens it from **My ISS work**, which is already reachable during a Restricted placement.
- The module's external domains are added to the package's **Sites to allow**, so it works in a Restricted placement.
- When the module reports **completed** or **passed** (the teacher chooses which), the item on the student's **Work to do** list can be marked done automatically. ISS staff still see it and can override.
- The sending teacher sees the SCORM result alongside the item's status.

### 8.3 ClassPulse
- A new activity type, **SCORM module**, in the lesson builder.
- During a session, students open it from the lesson. The teacher's live view shows each student's progress, and the lesson results include status and score.

### 8.4 Staff training
- Holders of `scorm.training` assign modules to staff: by school, by role, by group or individually. Each assignment can have a due date, recurrence (e.g. yearly) and reminders.
- Staff see a **My training** page in ClassGuard, with modules to do, due dates and completion history. They launch modules there.
- Reports show completion by school and person, overdue lists and CSV export. Attempts are kept for the district's chosen retention period; it's an audit record.

## 9. Filtering interactions

- The **content address** is always reachable for learners, like ClassGuard's own pages, including during Focus classes, Penalty Box and ISS. It's added to the allow rules in the DNS engine and the extension.
- A module's **external domains** are allowed only where the assigning context allows them:
  - in a Focus class, only if the teacher adds them to the class's sites (the assignment page offers **Add this module's sites to my Focus list**);
  - in ISS, through the package's Sites to allow (§8.2);
  - in Penalty Box, only through the normal Allow site flow.
- A Lockdown Test pointed at a SCORM module (e.g. a SCORM quiz) is possible later. It would need the content address and the module's domains in the lockdown allow list.

## 10. Data model (new migration)

```
scorm_packages
  id, title, scorm_version ('1.2'|'2004'), edition, owner_id,
  visibility ('private'|'school'|'district'), created_at, archived_at
scorm_package_schools            -- for visibility = 'school'
  package_id, school_id
scorm_package_versions
  id, package_id, version_no, manifest JSONB (organizations, SCOs, launch files,
  mastery score, has_sequencing), external_domains JSONB, total_bytes,
  uploaded_by, created_at
scorm_version_files
  version_id, path, blob_sha256, mime_type, size_bytes    PRIMARY KEY (version_id, path)
scorm_blobs                        -- content-addressed, chunked
  sha256, size_bytes, created_at
scorm_blob_chunks
  sha256, chunk_no, data BYTEA     PRIMARY KEY (sha256, chunk_no)

scorm_assignments
  id, package_id, pinned_version_id (NULL = latest), assigned_by,
  context ('class'|'students'|'iss_item'|'classpulse_activity'|'staff'),
  class_id, iss_item_id, classpulse_activity_id,
  due_at, max_attempts, done_when ('completed'|'passed'|'any'),
  recurrence, created_at, archived_at
scorm_assignment_targets           -- students, staff, schools, roles or groups
  assignment_id, target_type, target_id
scorm_attempts
  id, assignment_id, user_id, version_id, sco_id, attempt_no,
  status, completion_status, success_status, score_raw, score_scaled,
  total_time_seconds, location, suspend_data, cmi JSONB,
  started_at, last_activity_at, finished_at

settings keys: 'scorm_enabled', 'scorm_content_host', 'scorm_max_package_mb' (500),
  'scorm_storage_quota_gb' (20), 'scorm_teacher_upload' (true),
  'scorm_attempt_retention_days'
permissions: scorm.library, scorm.training, scorm.reports
```

## 11. Open questions

1. **Content address.** Can the district add a DNS name such as `content.<classguard-domain>` pointing at the ClassGuard VIP? The certificate would come from the existing ACME setup.
2. **Where modules come from.** Vendor courses (training providers, textbook publishers), in-house authoring tools (Articulate, iSpring, Adobe Captivate, H5P), or both? This decides which quirks to test first.
3. **Storage.** Is 500 MB per package and 20 GB total right for a start?
4. **Scores to Google Classroom.** Is this needed, given that ClassGuard would have to create the Classroom assignments itself (§8.1)?
5. **Sequencing.** Is "parts are freely choosable" acceptable for multi-part 2004 packages at first?
6. **Records.** How long should student and staff attempt data be kept? Student attempt data is part of the student's record.

## 12. Build phases (one PR each, plus Help articles)

1. **Engine:**
   - the content address and its security headers;
   - zip validation and manifest parsing;
   - the external-domain scan;
   - chunked, content-addressed storage with quotas;
   - the player on scorm-again, with launch tokens;
   - attempts and saving;
   - the library with preview and sharing (sharing by school needs ISS Phase 0's schools).
2. **Class assignments:** assign to a class or students, the student **My assignments** page (from the extension popup and Classroom links), teacher reports and CSV.
3. **Staff training:** assign to staff by school, role or group; due dates, recurrence and reminders; **My training**; training reports.
4. **ISS integration:** SCORM in assignment packages, auto-done on completion. After ISS Phase 3.
5. **ClassPulse activity:** the SCORM activity type and live progress.
6. **Later:** scores to Google Classroom, SCORM 2004 sequencing, xAPI or cmi5 if needed.

As with ISS, this is a starting point to refine once modules are running in real classes.
