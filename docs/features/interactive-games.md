# Interactive Games — Design Document

Status: **DRAFT — design only, no implementation**
Scope: a shared game engine for ClassPulse with pluggable game types; Jeopardy is the first plugin, not the architecture.

---

## 0. Context: what exists today (grounding)

Facts this design builds on, verified against the current tree (v0.17.x):

- **Stack**: Express 5 + raw-SQL `pg` (no ORM), Redis (ioredis), Socket.IO 4.8 with the
  Redis adapter on the same HTTP server/port as the REST API; React 19 + @tanstack/react-query 5 +
  react-router 8 + Tailwind 4 (CSS-first, no dark mode); JWT auth (`{ userId, email, role }`, 8h);
  roles `student < teacher < admin < superadmin` plus admin-tier custom-role permission keys.
- **ClassPulse model**: `classpulse_lessons → classpulse_pages → classpulse_questions →
  classpulse_question_options`; live runs are `classpulse_sessions` (FK to lesson, `join_code`
  UNIQUE, `status active|ended`, `current_page_id`) + `classpulse_session_students` +
  `classpulse_responses` (upsert on `(session_id, question_id, student_id)`). Sharing:
  `classpulse_lesson_shares` with `shared_with NULL` = school-wide.
- **Three surfaces already exist**: `TeachSession` (teacher console, inside Layout),
  `PresentSession` (chrome-free projector route, opened via `window.open`), `StudentJoin`
  (`/pulse/:code`, public route, students sign in with their school Google account — there is
  no anonymous identity anywhere in the platform).
- **Real-time**: Socket.IO rooms (`classpulse:dashboard:<id>`, `classpulse:session:<id>`),
  routes emit onto an in-process EventEmitter bus (`src/events.js`) which `src/sockets/index.js`
  bridges into room emits. Every surface *also* keeps a REST poll fallback (10–30s).
- **Media**: multer memory storage → magic-byte validation → local docker volume
  (`SCREENSHOT_DIR/classpulse-slides/...`) → authenticated streaming endpoint → `AuthedImage`
  (fetch-with-Bearer → blob URL) on the frontend. No object storage, nginx never serves media.
- **Conventions**: routes = HTTP concerns only (`routes/<camelCase>.js` mounted at
  `/api/v1/<kebab-case>`), services = logic, hand-rolled validation, error shape
  `{ error: "<string>" }`, migrations `NNN_snake_case.sql` (no down migrations), settings via
  the `settings` K/V table behind `ALLOWED_KEYS`, permission catalog in
  `services/permissions.js`, **no automated tests** — manual QA against
  `imageref/UI_TEST_CHECKLIST.md`, CI = lint/build/migrate/audit.
- **Deployment reality that matters**: ClassGuard runs **on-prem inside the district network**
  (HA pair, VIP). A WAN outage does not take games down; the realistic failure is a classroom
  AP or a student Chromebook dropping, which shapes the resilience section.

---

## 1. Architecture: engine vs. game

### 1.1 The line

**The engine owns everything that is true of every game.** A game type is a plugin that
supplies content structure, an inner phase graph, scoring rules, and render components. If a
proposed game needs the engine to change, that is a design event to be reviewed — not something
a game module can do silently.

| Engine (shared, one implementation) | Game type (per plugin) |
|---|---|
| Templates, ownership, sharing/library, tags | Content schema + validation (board, term pool, buckets…) |
| Sessions: create/lobby/pause/resume/end/abandon | Inner phase graph (`board → prompt → buzz → reveal → score`) |
| Join codes, participant + team registry | Action handlers (what "select tile" / "call square" does) |
| Score ledger (`game_score_events`) + team totals | Which score events to emit, point math, wagers |
| Timers (server-authoritative deadlines) | When to arm a timer and what expiry means |
| Real-time rooms, event fan-out, poll fallback, reconnect/rehydrate | Nothing — games never touch sockets directly |
| Host verbs common to all games (pause, skip, end, manual score adjust, kick/rename participant) | Game-specific host verbs (mark daily double, reveal answer, award to team N) |
| Participation modes + who-may-act enforcement | Which modes the game supports |
| Buzzer primitive (atomic first-in lock, lockout window) | Whether/where buzzing applies |
| Per-participant private state slots (see Bingo, §7.2) | What goes in them (a bingo card) |
| Results/summary persistence + retention | Results view layout |
| Random-picker utility (host tool, all sessions) | — |

### 1.2 The game-type interface

Backend: one module per game in `backend/src/services/games/types/<key>.js`, following the
platform's plain-functions-per-service convention. No classes, no framework:

```
module.exports = {
  key: 'jeopardy',                 // stable identifier, stored in DB rows
  name: 'Jeopardy',
  contentVersion: 1,               // stamped into session snapshots (§2.4)
  supportedModes: ['teacher_only', 'team_device', 'individual'],
  minTeams: 1, maxTeams: 8,        // engine enforces at lobby

  // Validation, hand-rolled per platform convention (no schema lib).
  // Returns [] or array of human-readable error strings ({error} shape upstream).
  validateContent(content) {},     // the template's content JSONB
  validateConfig(config) {},       // per-session options (timers, daily doubles…)
  defaultConfig() {},

  // State machine
  initialState(content, config, sessionCtx) {},   // → game_state for in_progress entry
  // One pure function: (state, action, actor, ctx) → result. NEVER does I/O.
  // actor = { kind: 'host' | 'participant', participantId?, teamId? }
  // result = {
  //   state,          // next game_state (replace, not mutate)
  //   scoreEvents: [{ teamId|participantId, delta, reason, itemRef }],
  //   emit: [{ event, payload, audience: 'all'|'host'|'team:<id>'|'participant:<id>' }],
  //   armTimer: { deadlineMs, onExpireAction } | null,
  //   error: '<string>' | null      // rejected action, state unchanged
  // }
  reduce(state, action, actor, ctx) {},

  // Engine calls this to strip host-only fields (answers!) before sending
  // state to projector/participant audiences.
  redactState(state, audience) {},

  // Results summary for the complete phase (pure, from state + score ledger rows)
  summarize(state, scoreEvents) {},
}
```

The reducer being **pure** (state in, state out, effects described not performed) is the single
most important property: it is what makes game logic unit-testable in a repo that currently has
no test infrastructure (§10), and what makes crash-recovery trivial (state is a JSONB column;
replay is unnecessary because every accepted action persists its resulting state).

Frontend: a parallel registry in `frontend/src/components/games/types/<key>/index.js`:

```
export default {
  key: 'jeopardy',
  ContentEditor,   // authoring surface inside the generic template builder shell
  HostPanel,       // teacher's private control surface (answers visible)
  Stage,           // projector view (never receives unredacted state)
  PlayerPad,       // student/team device view (only for supportedModes with devices)
  ResultsView,     // session results
}
```

### 1.3 Registration

- Backend: `services/games/registry.js` does `readdirSync(__dirname + '/types')` and
  `require`s each file at boot, validating the exported shape (key uniqueness, required
  functions present). Adding a game = adding one file. Engine code untouched.
- Frontend: Vite needs static imports, so `components/games/types/index.js` is a literal
  map `{ jeopardy, quizrace, ... }`. Adding a game = one new directory + **one line** in this
  map. This is the only "touch" required, and it is a manifest, not engine logic.
- The registry is exposed read-only at `GET /api/v1/games/types` (key, name, supportedModes,
  team limits) so the frontend never hardcodes the roster.

New game checklist (goes in the doc header of `registry.js`): backend type file, frontend
type directory + map line, checklist section in the test checklist (§10). No migration, no
engine edit, no new routes.

---

## 2. Data model

New tables, `game_` prefix, migration `1NN_games_engine.sql` following the `classpulse_`
precedent (module-prefixed, raw SQL, plain columns where the shape is universal, JSONB where
the shape is game-specific).

### 2.1 Templates and content

```
game_templates
  id               UUID PK DEFAULT gen_random_uuid()
  owner_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
  game_type        TEXT NOT NULL                 -- registry key; validated in code
  title            TEXT NOT NULL
  description      TEXT
  subject          TEXT
  grade_level      TEXT
  tags             TEXT[] NOT NULL DEFAULT '{}'
  folder           TEXT
  status           TEXT NOT NULL DEFAULT 'draft' -- draft | published | archived
  config           JSONB NOT NULL DEFAULT '{}'   -- default session config for this template
  content          JSONB NOT NULL DEFAULT '{}'   -- game-specific structure (see below)
  content_version  INTEGER NOT NULL DEFAULT 1    -- the game type's contentVersion at save
  question_set_id  UUID REFERENCES game_question_sets(id) ON DELETE SET NULL  -- optional, §2.2
  created_at, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()   -- updated_at via trigger

game_template_shares            -- mirrors classpulse_lesson_shares exactly
  id UUID PK
  template_id UUID NOT NULL REFERENCES game_templates(id) ON DELETE CASCADE
  shared_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
  shared_with UUID REFERENCES users(id) ON DELETE CASCADE   -- NULL = district-wide library
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  UNIQUE NULLS NOT DISTINCT (template_id, shared_with)
```

This is the object the user asked for directly: **teachers build games, keep them, and reuse
them across sessions**. A template is never consumed by running it (§2.4).

**Why `content` is JSONB and not rows.** ClassPulse's pages/questions are normalized because
every page has the same shape. Game content does not: a Jeopardy board (categories × values ×
rounds), a bingo term pool, sort-buckets, and a Feud survey have no common row shape. Forcing
them into a generic `game_template_items` table buys searchability we don't need (templates are
searched by title/tags/subject, not by question text) at the cost of every game doing
join-and-reassemble. Each game type's `validateContent` is the schema. The escape hatch for
cross-game reuse is §2.2.

### 2.2 Question sets (optional, shared content)

Two of the roster's games (Tug-of-War explicitly, Quiz Race practically) are *shells over a
question list*, and CSV import produces a flat question list before it produces a board. So the
flat list is its own first-class object:

```
game_question_sets
  id UUID PK, owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
  title TEXT NOT NULL, subject TEXT, grade_level TEXT, tags TEXT[] NOT NULL DEFAULT '{}'
  created_at, updated_at

game_set_questions
  id UUID PK
  set_id      UUID NOT NULL REFERENCES game_question_sets(id) ON DELETE CASCADE
  position    INTEGER NOT NULL
  prompt      TEXT NOT NULL
  answer      TEXT
  options     JSONB          -- [{text, correct}] for MC; NULL for open answer
  media       JSONB          -- { kind: image|audio|video, path|url, alt } (§8.4)
  points      INTEGER
  meta        JSONB NOT NULL DEFAULT '{}'   -- category hint, standard tag, etc.
  UNIQUE(set_id, position)
```

A template may reference a set (`question_set_id`) and its `content` then maps structure onto
set questions by id (Jeopardy: `content.board[round][cat][row] = { questionId, ... }`), or a
template may inline everything in `content` and ignore sets entirely. **Game types must accept
both**; the builder decides which to produce. Phase 0 ships the tables; the set-browsing UI can
trail (§9).

### 2.3 Sessions and live state

```
game_sessions
  id               UUID PK
  template_id      UUID REFERENCES game_templates(id) ON DELETE SET NULL
  game_type        TEXT NOT NULL              -- denormalized: survives template deletion
  teacher_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
  class_id         UUID REFERENCES classes(id) ON DELETE SET NULL
  join_code        TEXT UNIQUE                -- NULL for teacher_only mode (nothing to join)
  mode             TEXT NOT NULL              -- teacher_only | team_device | individual
  status           TEXT NOT NULL DEFAULT 'lobby'
                   -- lobby | in_progress | paused | complete | abandoned
  config           JSONB NOT NULL             -- template.config merged with launch overrides
  content_snapshot JSONB NOT NULL             -- frozen copy of template content at launch
  content_version  INTEGER NOT NULL           -- game type contentVersion at launch
  game_state       JSONB NOT NULL DEFAULT '{}'
  state_version    INTEGER NOT NULL DEFAULT 0 -- bumps on every accepted action
  allow_guests     BOOLEAN NOT NULL DEFAULT false   -- §8.1
  created_at, started_at, ended_at TIMESTAMPTZ

game_teams
  id UUID PK, session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE
  name TEXT NOT NULL, color_key TEXT NOT NULL, position INTEGER NOT NULL
  score INTEGER NOT NULL DEFAULT 0            -- cache; ledger is authoritative
  UNIQUE(session_id, position)

game_participants
  id UUID PK, session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE   -- NULL only for guests (§8.1)
  guest_token  TEXT                          -- server-minted, NULL for rostered
  display_name TEXT NOT NULL                 -- from roster, or approved guest name
  team_id      UUID REFERENCES game_teams(id) ON DELETE SET NULL
  status       TEXT NOT NULL DEFAULT 'active'   -- active | removed
  joined_at, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
  UNIQUE NULLS NOT DISTINCT (session_id, user_id)
  -- private per-participant slot (bingo card, assigned letters…), written by engine
  -- on behalf of the game type; redacted from all other audiences
  private_state JSONB NOT NULL DEFAULT '{}'

game_responses
  id UUID PK, session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE
  item_ref TEXT NOT NULL                     -- game-defined ref into content_snapshot
  participant_id UUID REFERENCES game_participants(id) ON DELETE CASCADE
  team_id        UUID REFERENCES game_teams(id) ON DELETE CASCADE
  payload    JSONB NOT NULL                  -- { choice }, { text }, { arrangement }, …
  is_correct BOOLEAN                         -- NULL until judged (host or reducer)
  response_ms INTEGER                        -- latency from prompt-open, for speed scoring
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()

game_score_events
  id BIGSERIAL PK                            -- ordering matters; bigserial not uuid
  session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE
  team_id UUID REFERENCES game_teams(id) ON DELETE CASCADE
  participant_id UUID REFERENCES game_participants(id) ON DELETE CASCADE
  delta INTEGER NOT NULL
  reason TEXT NOT NULL                       -- 'correct' | 'incorrect' | 'wager' | 'manual' | …
  item_ref TEXT
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL  -- teacher for manual adjustments
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

Indexes mirror the classpulse set: sessions by `(teacher_id, status)` and `(join_code)`,
participants/teams/responses/score_events by `session_id` (+ `(session_id, item_ref)` on
responses).

**Score is a ledger.** Every point change — reducer-emitted or teacher override — is a
`game_score_events` row; `game_teams.score` is a cache updated in the same transaction.
This gives manual-override auditability, an undo primitive (append a compensating event),
and a results timeline for free.

### 2.4 Why sessions snapshot content

`content_snapshot` decouples the live game from the template:

- One template can back many sessions — different teachers (via shares), different periods,
  the same period next semester — with zero cloning and no "someone edited the game while I
  was running it" corruption.
- Deleting/archiving a template leaves history intact (`template_id` SET NULL, snapshot stays).
- A game type can bump `contentVersion` and migrate `content` shape without stranding
  in-flight sessions: the session carries the version it launched with, and the type keeps
  a small upgrade function for old templates (upgrades happen on template edit, not on play).

The snapshot for a 5×5×2-round Jeopardy with text questions is a few KB; media stays
referenced by path, never embedded (§8.4).

---

## 3. Session lifecycle & state machine

### 3.1 Engine-level states

`draft` belongs to the **template** (`game_templates.status`), not the session — a session
only exists once a teacher clicks Launch. Session states:

```
            launch                    start
 (template) ──────►  lobby ──────────────────► in_progress ◄──────┐
                       │                        │       │  resume │
                       │ cancel                 │ pause └─────► paused
                       ▼                        │                 │
                   abandoned ◄──────────────────┼─────────────────┘ (timeout/cancel)
                                                │ finish (game signals terminal phase,
                                                ▼         or host force-ends)
                                            complete ──► (results view reads this state)
```

| Transition | Trigger | Who |
|---|---|---|
| → `lobby` | `POST /games/sessions` (from template) | host |
| `lobby → in_progress` | `POST …/:id/start` — engine calls `initialState()`, freezes teams | host |
| `in_progress → paused` | `…/pause`, or auto-pause on host absence (below) | host / engine |
| `paused → in_progress` | `…/resume` | host |
| `in_progress → complete` | reducer returns a terminal phase, or `…/end` | game / host |
| `lobby\|paused → abandoned` | `…/cancel`, or janitor cron after `game_session_abandon_hours` (default 12h — bell-ring reality: unfinished games die quietly overnight, resumable all day) | host / engine |

Per-question sub-states (`prompt → buzz → answer → reveal → score`) are **game-owned**, inside
`game_state.phase`, advanced exclusively through the reducer. The engine enforces only the
envelope: actions are rejected unless `status = in_progress` (host verbs pause/end/adjust-score
work in `paused` too), and `actor.kind` is checked against the mode before the reducer sees
the action.

### 3.2 The action pipeline (one path for everything)

All game interaction — host or student, REST or socket — funnels through one engine function:

```
applyAction(sessionId, action, actor):
  tx:
    row = SELECT … FROM game_sessions WHERE id=$1 FOR UPDATE   -- serializes per session
    engine-envelope checks (status, actor rights, mode)
    result = type.reduce(row.game_state, action, actor, ctx)
    if result.error → 409/400 { error }
    UPDATE game_sessions SET game_state=$, state_version=state_version+1
    INSERT score events; UPDATE team score caches; INSERT responses if any
  after commit:
    events.emit per result.emit (redacted per audience)  → sockets bridge fans out
    arm/clear timer per result.armTimer
```

`SELECT … FOR UPDATE` makes concurrent actions (two teams buzzing, teacher clicking during a
student submit) strictly ordered per session — no game code ever thinks about races. Actions
carry the client's `state_version`; a stale version on *state-changing participant actions* is
rejected with the current state in the response (client resyncs silently). Host verbs and
buzzes skip that check (a buzz is valid the instant buzzing opens, whatever the client had
rendered). Throughput ceiling of one lock per session is a non-issue at classroom scale
(§6.1); the buzzer hot path avoids the lock anyway (§6.3).

### 3.3 Host disconnect / student refresh

- **All state is server-side.** The host browser holds nothing authoritative — closing the
  tab, projector dying, Chromebook rebooting lose nothing. Reconnect = load
  `GET /games/sessions/:id` (full redacted-for-role state + `state_version`) and rejoin rooms.
- Host presence is tracked by socket heartbeat (classpulse's 30s/90s pattern). If no host
  connection for 3 minutes during `in_progress`, engine auto-pauses and the stage/participant
  surfaces show "Game paused — waiting for the teacher," preventing a dead session from
  eating a live countdown. (Timers freeze on pause: `deadline_at` converts to
  `remaining_ms` and re-arms on resume.)
- Student refresh: join is idempotent (upsert like classpulse), `private_state` and
  answered-item refs come back in the rehydrate payload, so a closed-and-reopened tab lands
  exactly where the game is. Mid-buzz reconnects simply miss that buzz window — acceptable
  and honest.

### 3.4 Timers

Server-authoritative, following the platform's bell-schedule idiom rather than tick
broadcasting:

- Reducer arms a timer → engine stores `{ deadline_at, on_expire_action }` inside
  `game_state._timer` and broadcasts it once. Clients render the countdown locally against a
  server-clock offset measured at socket connect (one `time` ping) — no per-second traffic.
- Enforcement is double: an in-process `setTimeout` on the API node feeds the expiry action
  back through `applyAction` (so expiry is just another reduced action), **and** every
  incoming action first checks for a lapsed deadline and applies the expiry before the new
  action. The second path makes timers correct even across an API restart or HA failover —
  no timer state lives only in process memory.

---

## 4. Two-surface (actually three-surface) rendering

Follow the ClassPulse pattern exactly — it already answers the "separate windows?" question:

| Surface | Route | Placement | Who |
|---|---|---|---|
| Host control | `/games/sessions/:id/host` | inside `<Layout>`, `RequireAuth minRole="teacher"` | teacher |
| Projector stage | `/games/sessions/:id/stage` | **outside** Layout (chrome-free), teacher auth | class-facing |
| Player pad | `/play/:code` | public route (like `/pulse/:code`) | student/team device |

- Host opens the stage with `window.open(..., '_blank', 'noopener')` (TeachSession precedent)
  and drags it to the projector display. They are separate windows that **do not talk to each
  other** — both subscribe to the same session room and render the same server state, which is
  what already keeps TeachSession/PresentSession in sync. No BroadcastChannel, no opener
  messaging; one sync mechanism, not two.
- **Redaction is server-side per audience** (`redactState`): the stage and pads are
  structurally incapable of leaking answers, mirroring how PresentSession strips `is_correct`
  today — except enforced in the engine, not by each view remembering to.
- Host panel: standard app styling (`.btn`, `.card`), information-dense — answers visible,
  next-question preview, per-team adjust buttons (±100 or custom), skip, pause, end, kick,
  picker tool. Everything reachable while the projector shows only the class-safe view.
- **Stage is projector-safe by convention** (documented in the games UI folder): minimum
  text ≥ `text-3xl` (readable at 8–10m), WCAG-AA contrast pairs only, no interactive chrome,
  no hover states, board/state fills the viewport, join code persistently in a corner in
  `font-mono font-black tracking-[0.3em]` (PresentSession's treatment). The stage may use a
  dark self-contained palette (Jeopardy's classic deep blue) — precedent: `/wallboard` styles
  itself; the app-global no-dark-mode rule applies to chrome, not to a chrome-free stage.
- Player pad: mobile-first, thumb-reach layout, touch targets ≥ 44px, works identically with
  keyboard (buzz = Space/Enter, §8.3).
- **Fix while we're here**: PresentSession tells students "Join at {host}/pulse" but no
  `/pulse` route exists (only `/pulse/:code`). Games ship `/play` as a code-entry landing
  page, and the same tiny component should back `/pulse` to close that gap.

---

## 5. Participation modes

Mode is chosen at launch, stored on the session, enforced by the engine's actor checks.
Game types declare `supportedModes`; the launch modal only offers the intersection.

1. **`teacher_only` — no student devices. This is the floor and it must be excellent.**
   No join code is even generated. Teacher creates teams in the lobby ("Row 1", "Blue"),
   drives every phase from the host panel, and awards points with one tap per team
   (+value/−value buttons sized for speed). Students shout, raise hands, or use whiteboards.
   Every game type must be fully playable in this mode unless it structurally cannot be
   (Quiz Race is the roster's only exception, §7.1) — this is the most common classroom
   reality and the Phase 1 target.

2. **`team_device` — one device (or physical buzzer station) per team.**
   Device joins via code and claims a team in the lobby (host can reassign). The device is
   the team's buzzer and answer input; scoring still resolves through the reducer. A team
   device may be anonymous-by-nature (it represents a team, not a person): it joins as a
   guest participant bound to the team, no student identity involved — which also makes this
   the mode that works with zero student PII (§8.1).

3. **`individual` — every student joins on their own device.**
   Rostered join identical to ClassPulse (`/play/:code` → school Google sign-in → upsert
   participant). Students are auto-dealt to teams (round-robin with roster names), or play
   solo where the game is individual (Quiz Race, Bingo). Their responses are attributable,
   which enables the results view teachers actually want ("who missed this?").

**Rostered vs anonymous join**: rostered is the default and the recommendation — it reuses
the entire existing auth path, produces zero new PII (display names come from the roster),
and inappropriate-name moderation never arises. Guest join (`allow_guests`) is designed
(§8.1) but ships **off** by default and can trail to a later phase; `team_device` mode
covers most "devices without identities" needs without it.

---

## 6. Real-time transport

### 6.1 Options against this stack

Load model: ≤35 students/session, several concurrent sessions per building, LAN-local server.
Event rate is trivial (a buzz burst is ~35 messages in a second; state broadcasts are a few
KB). Transport choice is about **fit and reconnect behavior**, not throughput.

| | Socket.IO (existing) | SSE + REST actions | Short polling |
|---|---|---|---|
| Infra today | Server, Redis adapter, JWT middleware, nginx upgrade blocks, client context, extension client — all deployed | Nothing exists; new nginx buffering config (`X-Accel-Buffering: no`), new auth path (EventSource can't send headers → token-in-query or cookie) | Exists (classpulse fallback pattern) |
| Bidirectional | Yes — buzz path needs client→server latency in ms | Downstream only; buzzes go over REST (fine: +one HTTP RTT on LAN) | Both directions slow |
| Reconnect | Built-in backoff + room rejoin; classpulse already exercises it | Built-in `EventSource` retry (good) but rooms/fan-out hand-rolled | Trivial |
| Latency | ~ms on LAN | ~ms down; REST-RTT up | Poll interval (1–10s) — kills buzzers/leaderboards |
| Marginal complexity | ~zero new concepts | A second real-time idiom to maintain forever | Zero, but gameplay ceiling |

**Recommendation: Socket.IO**, without hesitation. Games add rooms
(`game:host:<id>`, `game:session:<id>`, and per-team where needed) and events (`game:action`,
`game:state`, `game:buzz`) to the existing `sockets/index.js` + event-bus bridge, exactly as
ClassPulse did. Introducing SSE would mean two real-time stacks for one team to maintain;
polling alone can't do buzzers. The Redis adapter already makes fan-out HA-correct.

### 6.2 Reconnect / resume (students WILL close the tab)

- Poll fallback stays, per ClassPulse: pads poll `GET /games/sessions/:id/state` every 10s
  whenever the socket is down; the response carries `state_version`, and any received socket
  event with a version ≤ the last applied one is dropped (idempotent, unordered-safe).
- Socket reconnect → rejoin room → one full state fetch. All client state is disposable.
- The **host panel** additionally keeps its last-known state in memory and stays interactive
  for score adjustments even fully offline, queueing nothing: buttons disable except
  score/notes, with a visible "reconnecting…" bar. Combined with `teacher_only` mode always
  being one pause away (§8.5), the teacher can always finish the game.

### 6.3 Buzzer logic (engine primitive)

- Reducer opens buzzing → engine creates Redis key `game:<sessionId>:buzz:<itemRef>`.
- `game:buzz` socket events race on `SET key <participantId> NX PX <windowMs>` — **atomic
  first-in across both HA nodes**; exactly one wins, order is total, no app-level tiebreak
  needed. The winner is fed through `applyAction` as a `buzz_won` action; losers get an
  instant `buzz_lost` (their pad flashes "locked out") without touching the DB row lock.
- Early-buzz lockout (config, default 250ms): buzzing before the reducer opens the window
  sets a per-participant Redis lockout key; their next buzz is ignored until it expires —
  the classic anti-jump-the-gun rule.
- Fairness note (documented, not solved): device/network latency skews ties by tens of ms on
  wifi. This matches every commercial classroom tool; physical fairness needs physical
  buzzers (`team_device` mode with USB/Bluetooth buttons mapping to keypress works today).

---

## 7. Game roster against the engine

### 7.1 Jeopardy — full specification (first plugin)

**Content** (`game_templates.content`):

```
{
  "rounds": [                       // 1..3; round 2 typically doubles values
    { "name": "Round 1", "multiplier": 1,
      "categories": [               // N columns (default 5, 3..8)
        { "title": "State Capitals",
          "tiles": [                // M rows (default 5, 3..8)
            { "id": "r1c1t1", "value": 200,
              "question": { "prompt": "...", "media": {…}|null },
              "answer": "...",
              "dailyDouble": false } ] } ] } ],
  "finalRound": { "enabled": true, "category": "...", "prompt": "...", "answer": "..." } | null
}
```

`validateContent`: ≥1 round, rectangular category/tile grid per round (equal tile counts),
values positive, ≤2 daily doubles per round, prompts non-empty, media refs resolvable.
Value defaults are generated (`100..500 × multiplier`) but every tile's value is editable.

**Config** (per session): `{ questionTimerSec: 0|15|30|60, dailyDoubles: bool, finalRound:
bool, buzzLockoutMs: 250, allowNegative: true, autoOpenBuzz: false }`.

**Phase graph** (inside `game_state`):

```
board ──select(host|winner-team picks, host confirms)──► showing_prompt
showing_prompt ──(devices? open_buzz : host judges directly)──► buzz_open | judging
buzz_open ──first buzz──► answering(teamX) ──host: correct──► reveal
answering ──host: incorrect──► buzz_open (teamX locked out for this tile) | judging
judging ──host awards/denies any team──► reveal
reveal ──continue──► board (tile marked used; winner picks next)
board ──all tiles used──► next round | final_wager (if enabled) | done
final_wager ──all wagers in (host-entered in teacher_only)──► final_prompt
final_prompt ──► final_judging ──► done
daily double: showing_prompt is preceded by wager(teamX) — only the selecting team answers
```

- Board state: `usedTiles: Set<tileId>`, `pickingTeam`, `currentTile`, `lockedOutTeams`,
  round index. Reveal shows the canonical answer on the stage.
- Scoring: reducer emits `±value` (wager for daily double/final); incorrect deducts if
  `allowNegative`. Teacher override is the engine verb, not Jeopardy code.
- `teacher_only` mode: `buzz_open` collapses into `judging` — host hears the room and taps
  the winning team, +/− per tile value. Two taps per question total; that speed budget is a
  hard UX requirement for the host panel.
- Stage: classic board (category headers, value tiles, used tiles dimmed/blanked), full-bleed
  prompt view with countdown ring when timed, team score strip along the bottom at all times.
- `redactState` strips `answer` fields and daily-double flags until the relevant reveal.

**Engine reuse**: sessions/teams/ledger/timers/buzzer/picker/reconnect — Jeopardy's own code
is the board schema, the phase graph above, and four render components.

### 7.2 The other eight (schema + machine sketch; implementation phased)

| Game | Content schema (JSONB sketch) | Phases | Engine reuse / unique / **misfit flags** |
|---|---|---|---|
| **Quiz Race** (Kahoot-style) | question list (ideally a `question_set_id`): MC options, correct index, per-q time limit | `question(n): prompt → collecting(deadline) → reveal → leaderboard` → repeat → podium | Reuses timers, individual scoring, leaderboard from ledger. Unique: speed-decay points (`base × remaining/total`), simultaneous collection (**not** buzz — all answer at once), streak bonus. **Flag: requires devices** — first `supportedModes` without `teacher_only`; the engine must treat mode support as per-game, not universal. Designed in §5; no interface change needed. |
| **Bingo** | `{ pool: [terms], callList: [prompts] | derived, cardSize: 3|4|5, freeCenter: bool, winPatterns: [row,col,diag,blackout] }` | `calling: call(n) → (claims?) verify_claim → valid ? bingo_won : resume` | Unique: **per-participant private state** — each pad gets a seeded, server-generated card in `game_participants.private_state`; claim verification replays called-set ∩ card against win patterns server-side. Teacher-only mode = printed cards + stage shows call history. **Flag (interface-shaping): needed the private-state slot — added to the engine (§2.3) rather than hacked into game_state, because Word Reveal team variants and future games want it too.** |
| **Memory Match** | `{ pairs: [{a: {text|media}, b: {…}}], gridSize }` | `turn(team): pick1 → pick2 → match? scored : flip_back → next turn` | Unique: turn rotation (engine gets a tiny `turnOrder` helper in game_state conventions, not new machinery), grid shuffle seed. Relay mode = team turn order. Fits cleanly. |
| **Word Reveal** (hangman-style) | `{ words: [{word, hint, category}], maxMisses, revealMode: letters|wheel }` | `playing: guess(letter) → hit/miss → solved|failed → next word` | Nearly pure engine shell: shared state, team turns, letter keyboard on pads or host enters shouted guesses. Unique: masked-word rendering, on-screen A–Z state. Fits trivially. |
| **Survey Says** (Feud) | `{ questions: [{prompt, answers: [{text, points, aliases[]}] }] }` (top-N ranked) | `faceoff(buzz) → team_play: guess → reveal|strike(×3) → steal → scored` | Reuses buzzer, team scoring, reveal. Unique: answer matching — exact + alias list; in device modes a typed guess auto-matches with **host confirm** for near-misses (no fuzzy-match rabbit hole in v1); teacher_only = host taps the matching answer row. Fits. |
| **Sort & Categorize** | `{ buckets: [{id,label}], items: [{id, text|media, bucketId}], timerSec }` | `sorting(deadline): submissions → reveal per-item → scored` | Reuses timers, simultaneous collection (Quiz Race's pattern), team/individual scoring. Unique: drag-and-drop pad UI (touch-first; keyboard alternative: select item → select bucket — required for a11y, §8.3), partial-credit scoring. Fits. |
| **Team Tug-of-War** | `question_set_id` + `{ target: 10, step: 1 }` — deliberately minimal | `question → judge → rope moves ± → target reached? won` | **Purpose: proof the engine is an engine.** Zero unique server logic beyond rope position = f(score diff); its stage is one visual. If Tug-of-War needs anything bespoke beyond a reducer of ~50 lines, the interface is wrong. Also the cheapest second `teacher_only` game to ship. |
| **Random Picker / Spinner** | — | — | **Flag: correctly does NOT fit — and is deliberately not a game type.** No content, no scoring, no session lifecycle of its own. Modeled as an **engine host-tool**: available inside every session's host panel (picks from that session's participants or the class roster) and as a standalone teacher page (`/games/picker`, roster-fed). Forcing it through the registry would distort the interface to accommodate a stateless utility; excluding it is the interface working. |

**Interface verdict from the roster exercise**: two engine additions were discovered and
folded back into §1/§2 — per-participant `private_state` (Bingo) and per-game
`supportedModes` (Quiz Race). Everything else fit. The picker's non-fit is by design.

---

## 8. K-12 constraints (requirements)

### 8.1 Privacy — FERPA/COPPA posture

- **Data minimization by construction**: rostered joins add *zero* new PII — identity is the
  existing `users` row; display names are roster names. Game rows add only gameplay data
  (responses, scores). No emails/photos ever reach the stage or pads.
- **Join-code exposure**: the unauthenticated `GET /games/join/:code` probe returns only
  `{ gameTitle, gameType, teacherLastName, status }` — deliberately *less* than ClassPulse's
  equivalent (which leaks teacher full name + full current page pre-auth; noted as a
  hardening follow-up there). Codes: 6 chars, same 32-char no-lookalike alphabet, generated
  with `crypto.randomInt` (upgrade over classpulse's `Math.random`), valid only while the
  session is joinable, never printed anywhere durable.
- **Display names**: default = roster `given_name` + last initial on stage and pads
  (full name only on the host panel and results). Because names come from the roster,
  the inappropriate-name problem is structurally absent in rostered modes.
- **Guest mode** (`allow_guests`, default off, admin-settable district-wide via settings key
  `games_allow_guests`): guests pick a name → **held in a host approval queue before it
  appears anywhere**, host can rename/remove any participant at any time (engine verbs), and
  a small district-editable blocklist pre-filters the obvious. Guests exist only as a
  `game_participants` row with a session-scoped token — no `users` row, nothing outlives the
  session but an opaque participant id in results. Recommendation stands: ship rostered-only
  first; the projector never shows an unvetted string.
- **Retention**: mirror ClassPulse — setting `games_response_retention_days` (0 = forever)
  pruning `game_responses` + `game_score_events` for ended sessions; template/library data
  is teacher IP and keeps.
- COPPA: no accounts are created by this feature, no third-party services are contacted,
  everything is first-party on district-owned infrastructure. The engine adds no analytics.

### 8.2 Devices — Chromebooks, iPads, school wifi

- Pads are plain React routes — no install, no app store. Touch and keyboard co-equal
  (§8.3). Targets ≥ 44×44px; no hover-dependent affordances; portrait-first layout.
- Constrained-wifi budget: state broadcasts are diffs of a few KB; timers don't tick over
  the wire (§3.4); **media renders on the stage only, never fanned to 35 pads** (§8.4) —
  the pad shows answer inputs, not the video.
- Old-Chromebook floor: target the Chromebook fleet's minimum Chrome version (LTS channel);
  no APIs newer than what the existing StudentJoin flow uses. iPad Safari: verify
  Space-to-buzz alternatives (on-screen button is primary everywhere) and audio autoplay
  policies (stage audio requires one host gesture — play buttons, never autoplay).

### 8.3 Accessibility — WCAG AA

- All stage/pad text pairs meet AA contrast (large-text ratios apply on stage); host panel
  follows existing app styling.
- **Never color alone**: team identity = color + name + icon shape (the engine's
  `color_key` maps to a colorblind-safe palette of color+glyph pairs, validated with the
  repo's dataviz process); correct/incorrect = icon + text, not green/red alone; the
  tug-of-war rope carries team glyphs.
- Keyboard: every pad interaction has a key path (buzz = Space/Enter; MC = 1–4/A–D;
  sort = select-item → select-bucket picker as the DnD alternative). Focus visibly managed
  on phase transitions.
- Screen readers: pads announce phase changes and results via `aria-live="polite"`
  (`assertive` for buzz-window-open); the stage is decoration for sighted audiences, the
  *pad* is the accessible surface — this division is documented per game.
- Timers: countdown is visual + numeral (no color-only urgency); config allows extending
  or disabling per session (accommodations), and the host can always extend a live timer.

### 8.4 Media handling (questions: text, image, audio, video)

- Follow the slide-image pipeline: multer memory → magic-byte validation → volume path
  `games-media/<templateId>/<uuid>.<ext>` under `SCREENSHOT_DIR` → relative path stored in
  content JSON → authenticated streaming endpoint `GET /api/v1/games/media/:templateId/:file`
  with the same resolve+prefix traversal guard, plus **HTTP Range support** (required for
  audio/video scrubbing; the existing image streamer doesn't need it, this one does).
- Caps: images 10MB (PNG/JPEG magic bytes, existing constants), audio 20MB (MP3/M4A),
  **video: recommend link-only in v1** (YouTube/Drive embed on the stage — this is a Google
  Workspace district; native uploads mean transcoding questions, big volumes, and backup
  bloat for marginal value). Revisit if teachers actually ask for uploads. Tradeoff stated:
  embeds depend on WAN + YouTube policy; the mitigation is that video is decoration for a
  question, not the mechanic.
- Frontend: generalize `AuthedImage`'s fetch-to-blob pattern into `AuthedMedia`
  (image/audio; video only when a local file exists). Media plays on the **stage**;
  pads get `media.alt` text.
- Snapshot note: sessions snapshot content JSON but reference media by path — deleting a
  template offers "delete media too?" only when no sessions reference it (count query).

### 8.5 Resilience & classroom reality

- On-prem server: internet loss doesn't touch gameplay (only video embeds die — another
  reason for §8.4's stance). The realistic failures are one student's wifi and the
  teacher's own device.
- Every device-mode session can be **downgraded live**: `pause → switch mode → resume`
  (engine verb, `individual/team_device → teacher_only`) — participants keep their teams,
  the reducer sees only actor-kind changes, and the teacher finishes the game by hand.
  This one verb is the whole graceful-degradation story, and it must be a Phase-2 test case.
- Bell rings: `pause` is instant and durable (state is a DB row); `paused` sessions are
  resumable from the hub all day and auto-abandon after `game_session_abandon_hours`
  (default 12h) so the hub doesn't fill with zombies. Results of abandoned sessions remain
  viewable (scores as of abandonment).
- HA failover mid-game: state and timers survive (DB + deadline re-check design, §3.4);
  sockets reconnect to the VIP; clients rehydrate. Worst case is a lost buzz window —
  re-opened by the host with one tap.

---

## 9. Integration with ClassPulse presentations

**Question: is a game a slide type, or a standalone object linkable from a deck?**

| | A. Game as a slide (`content_type: 'game'`) | B. Standalone object + link page (recommended) |
|---|---|---|
| Authoring | One builder… that must embed every game's ContentEditor inside LessonBuilder | Game Builder and Lesson Builder stay separate; the lesson embeds a *reference* |
| Reuse | Game content trapped inside one lesson — the exact cloning problem §2.4 exists to kill; contradicts the "teachers keep games and reuse them" requirement | Same template reusable across any number of lessons and standalone runs |
| Lifecycle | A slide's lifetime is a page flip; a game is a stateful session with teams and scores — jamming a session inside `current_page_id` navigation means ClassPulse navigation now owns game state edge cases (what does "Next slide" mid-Final-Jeopardy mean?) | Session lifecycle stays in the engine; the deck just points at it |
| Surfaces | ClassPulse's Present view would need to host the game stage | Both modules keep their own stage/host surfaces; launch opens them |
| Coupling | `classpulse_pages` schema + TeachSession/PresentSession/StudentJoin all grow game awareness | One new `content_type` value and one small card component |

**Recommendation: B.** Concretely: a `classpulse_pages.content_type = 'game_link'` page
stores `{ game_template_id }` (validated against share visibility). In TeachSession it
renders a card — game title, type, "Launch" → creates/attaches a `game_sessions` row
(carrying the ClassPulse session's `class_id`) and opens the host panel; on the ClassPulse
projector view it shows title + join code once launched; ClassPulse's student surface shows
"switch to the game" linking `/play/:code`. When the game completes, the host panel offers
"back to lesson." The two systems share only a foreign key and a launch button. (`game_link`
lands with games Phase 3; nothing in Phases 0–2 touches ClassPulse tables.)

Navigation: games live in the ClassPulse hub as a sibling — nav `ClassPulse ▸ Games`
(`/games` = library, `/games/new`, `/games/sessions/:id/*`), permission key `games` added to
the catalog's ClassPulse section (`requirePermissionIfAdmin('games')` — teachers unrestricted,
per platform model).

---

## 10. Testing approach

Per the repo's convention (no automated suite; manual QA against `imageref/UI_TEST_CHECKLIST.md`):

- **Checklist**: add `## Games — Library (/games)`, `## Games — Builder (/games/:id/edit)`,
  `## Games — Host (/games/sessions/:id/host)`, `## Games — Stage (…/stage)`, and a
  `### Player (/play/:code)` subsection under Teacher View, in the checklist's exact idiom:
  route-titled sections, **bolded action flows** (`→ expected`), every section ending with
  `- **Edge case:**` bullets, `⚠ Known issue` tags for shipped-known gaps. Seed edge cases
  from this doc: host tab close mid-question, student refresh mid-buzz, pause at bell +
  resume next period, mode downgrade mid-game, two-tab teacher, stale `state_version`
  resubmit, timer expiry racing a submit, tie buzz, negative scores, guest-name queue.
- **Engine/reducer unit tests — proposed convention addition** (needs sign-off, Open
  Question 5): the reducers are the first genuinely pure logic in the repo, and manual
  checklists cannot cover a Jeopardy phase graph × modes × edge cases. Proposal: node's
  built-in `node:test` runner (zero new dependencies, matching the lean-deps posture),
  `backend/src/services/games/__tests__/`, wired as `npm test` so the **existing** CI step
  (`npm test --if-present`) starts executing without a workflow change. Scope: engine action
  pipeline + every game reducer (table-driven: state + action → expected state/events).
  If declined, reducers get exercised via the checklist plus throwaway harness scripts, and
  the risk register keeps R1 at the top.
- **Headless render sweep**: extend the established scratchpad Playwright harness
  (mock-server + fixture API pattern used for every recent frontend verification) with
  fixtures for the five new routes — stays session-tooling, not committed CI, per current
  practice.
- **Multi-client live test**: the checklist's games sections get a one-page "smoke script"
  preamble: one host + projector + two pads (one Chromebook, one iPad) running one Jeopardy
  round and one Quiz Race — the 10-minute pass a release needs.

---

## 11. Phased implementation plan

**Phase 0 — engine core + data model** (no user-visible feature; ~1.5–2 wks)
Migration (`game_*` tables §2), engine service (`applyAction` pipeline, session lifecycle,
teams, ledger, timers, redaction), registries (backend dir-scan + frontend map), routes
(`/api/v1/games/*`), socket rooms/events + bus bridge entries, host/stage/pad route shells,
and a throwaway `_smoke` game type (3-question shell) proving the plugin contract end-to-end.
**Done when**: `_smoke` plays teacher-only through lobby → complete with scores on the ledger,
reducer tests green (if §10 accepted), pause/resume/abandon verified.
*Depends on*: Open Questions 1, 5.

**Phase 1 — Jeopardy, teacher-only MVP** (~2–3 wks)
Jeopardy type (schema, reducer, all four components), template builder (board grid editor,
per-tile editor, rounds, value autofill, image media), **CSV/paste bulk import** (columns:
round, category, value, prompt, answer — non-negotiable per spec), library page (own +
shared-with-me), duplicate, launch modal, host panel + stage polished to the two-taps-per-
question budget, manual scoring, timers, used-tile tracking, daily double + final round
(host-entered wagers). No join codes, no pads.
**Done when**: a teacher builds a 5×5×2-round game from a pasted CSV in <10 min and runs it
start-to-finish on a projector with zero developer involvement; checklist sections pass.
*Depends on*: Phase 0.

**Phase 2 — student devices + real-time** (~2–3 wks)
`/play/:code` + `/play` landing (and backfill `/pulse`), rostered join, lobby/team claiming,
buzzer primitive (Redis SETNX + lockout), Jeopardy device modes, **Quiz Race** (validates
individual mode, speed scoring, simultaneous collection, leaderboard), reconnect/rehydrate,
live mode-downgrade verb, host-absence auto-pause.
**Done when**: 30+ real devices play both games through a full session including forced
mid-game refreshes, an AP-drop drill, and a mode downgrade; buzz ties resolve cleanly.
*Depends on*: Phase 1; Open Question 2 (guests) before building any guest UI.

**Phase 3+ — roster breadth + library + integration** (incremental, ~3–7 days per game)
Order by classroom value: Tug-of-War (cheap, proves the shell), Word Reveal, Bingo
(private-state exercise), Sort & Categorize, Memory Match, Survey Says. Question-set browsing
UI + set-backed templates. District library browse/search. Random-picker host tool +
standalone page. ClassPulse `game_link` page type (§9). Audio media + `AuthedMedia`.
Guest mode if approved. Wiki/KB articles per the release workflow.
**Done when** (per game): schema + reducer + components + checklist section + reducer tests;
(for library): shared templates discoverable by subject/grade with dedupe-by-duplicate-count
visible.

Sizing assumes the current solo-maintainer cadence (PR-sized slices, each independently
deployable behind the absence of nav links until its phase completes).

---

## 12. Open questions (need answers before implementation)

1. **Module naming/placement**: "Games" as a ClassPulse sibling (nav `ClassPulse ▸ Games`,
   tables `game_*`, permission key `games`) — confirm, or prefer full ClassPulse branding
   (`classpulse_games_*`)? Affects the migration, so needed before Phase 0.
2. **Guest (anonymous) join**: ship rostered-only through Phase 2 with guest mode deferred
   (recommended), or is anonymous join a launch requirement for some population
   (e.g., co-taught rooms with unrostered aides/visitors)?
3. **Physical buzzers**: do any classrooms already own USB/Bluetooth buzzer sets we should
   support explicitly in `team_device` mode (they present as keyboards — cheap to support,
   want to know now for the input mapping)?
4. **Video policy**: confirm link-only video (YouTube/Drive embeds) for v1 — or are there
   filtered-network constraints that make *local upload* the more reliable path in your
   buildings (you know your filter posture best)?
5. **Testing convention change**: approve introducing `node:test` reducer tests as the
   repo's first committed test suite (existing CI picks it up via `npm test --if-present`,
   zero new deps)? This is a workflow-convention decision, not a technical one.
6. **Retention**: mirror `classpulse_response_retention_days` with a games equivalent —
   same default (keep forever until set)?
7. **Who can author**: all teachers (recommended, matching ClassPulse lessons), or
   admin-gated during rollout?

## 13. Risks and unknowns (ranked)

1. **State-machine correctness without tests** — a phase-graph bug during a live class is
   the worst failure mode this feature has. *Mitigation*: pure reducers + the §10 test
   proposal; if declined, this risk stays #1.
2. **Scope creep across 8 game types** — each is "small," together they're a platform.
   *Mitigation*: the registry makes each additive and independently shippable; phases gate
   breadth behind an engine that two very different games (Jeopardy, Quiz Race) have proven.
3. **Host-panel UX speed** — if awarding points takes more taps than a whiteboard, teachers
   won't use it. The two-taps-per-question budget is a Phase-1 acceptance criterion, not a
   nice-to-have.
4. **JSONB state/content shape drift** across versions — mitigated by `content_version`
   stamping + upgrade-on-edit (§2.4), but discipline is on us; reducers must tolerate their
   own historical states.
5. **Buzz fairness perception** on contended wifi — bounded by Redis-atomic ordering and the
   documented physical-buzzer path; expectations set in teacher-facing docs.
6. **iPad Safari quirks** (audio autoplay, viewport, wake-lock during long questions) —
   Phase-2 device-matrix testing; no API bets newer than the existing student surfaces.
7. **Concurrency unknowns at building scale** (several simultaneous sessions) — load is
   objectively small, but the per-session `FOR UPDATE` serialization + Redis buzz path
   should be sanity-checked with a 100-virtual-client script during Phase 2.

---

*Prepared as a design-only deliverable. No application code accompanies this document.*
