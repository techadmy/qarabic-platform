# Qarabic API (`apps/api`)

NestJS 12 + Prisma 7.10 + PostgreSQL 17. Setup and commands: see the root `README.md`.
Every request/response shape lives in `@qarabic/shared` (zod); the API validates with the same
schemas the web forms use. OpenAPI (generated from those schemas) at `/api/docs` outside production.

## Conventions

- Prefix `/api/v1`. Cookie session + CSRF (`GET /auth/csrf`, then `X-XSRF-TOKEN` on unsafe requests).
- Deny by default: `@Public()`, `@Authenticated()` (own account), `@Can(p…)` (all listed),
  `@CanAny(p…)` (one of them; the handler applies the row scope). `test/route-coverage.e2e-spec.ts`
  pins the permission of every route.
- Errors: `{ message, code, errors?, data? }`. `422 validation_failed` with `errors` per field
  (`errors.email`, `errors["permissions.1"]`); business refusals use their own `code` and, when
  useful, `data` (e.g. `409 role_in_use` + `data.usersCount`).
- A single record answers `{ data }`. A list answers `{ data, meta }` where
  `meta = { page, perPage, total, lastPage, counts }` and `counts` holds the status-tab numbers
  (`all` + one per status) for the same search and filters, ignoring the `status` filter.
- List query (all People lists): `q` (instant search, `%`/`_` literal), `archived` (`1|true`: the
  "deleted" switch), `page` (1…), `perPage` (1–100, default 25), `sort`, `order` (`asc|desc`), plus
  each list's filters. Lists are rate limited at 120 requests a minute (Laravel `throttle:120,1`).
- Dates are `YYYY-MM-DD`; instants are ISO 8601 UTC; money is a decimal string (`"120.00"`) with
  its currency; phones are E.164 (`+447700900123`, input may contain spaces, dashes, dots, brackets);
  countries are ISO 3166-1 alpha-2; time zones IANA names.
- Writes are transactions with row locks; every create / update / status / archive / restore /
  role change writes an `audit_logs` row (actor, action, subject, before/after, reason).

## Endpoints (N0 + N1)

| Method | Path                                                           | Permission                                               | Notes                                                                                                                              |
| ------ | -------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                                                      | public                                                   |                                                                                                                                    |
| GET    | `/auth/csrf`                                                   | public                                                   |                                                                                                                                    |
| POST   | `/auth/login`, `/auth/forgot-password`, `/auth/reset-password` | public                                                   | rate limited                                                                                                                       |
| POST   | `/auth/logout`                                                 | signed in                                                |                                                                                                                                    |
| GET    | `/auth/me`, `/me`                                              | signed in                                                | `Me` (`phone`, `role {name, labelAr, labelEn, kind}`, `teacherId` for a teacher login — N3)                                        |
| PATCH  | `/me`                                                          | signed in                                                | `updateMeSchema`: name, locale, timezone, phone; password with `currentPassword` (signs out other sessions, 5/min)                 |
| GET    | `/people/lookups`                                              | any of `families.manage`, `staff.manage`, `users.manage` | `PeopleLookups`                                                                                                                    |
| GET    | `/families`                                                    | `families.view`                                          | parent: own family only. Filters `status`, `managerId`, `countryCode`; sort `id                                                    | parentName | startDate  | createdAt` |
| GET    | `/families/:id`                                                | `families.view`                                          | `FamilyDetailDto`; parent: own only (else 404), no staff notes                                                                     |
| POST   | `/families`                                                    | `families.manage`                                        | `createFamilySchema`; makes the parent login (random password)                                                                     |
| PATCH  | `/families/:id`                                                | `families.manage`                                        | `updateFamilySchema`; `status` refused (use `/status`)                                                                             |
| POST   | `/families/:id/status`                                         | `families.manage`                                        | `familyStatusChangeSchema`; reason for on_leave/suspended/deactivated                                                              |
| DELETE | `/families/:id`                                                | `families.manage`                                        | archive, body `{reason}`; only `deactivated`; children archived with it; parent login closed                                       |
| POST   | `/families/:id/restore`                                        | `families.manage`                                        | brings back the children archived with it; login reopened                                                                          |
| GET    | `/students`                                                    | any of `families.view`, `sessions.conduct`               | teacher: own students, no email/parent data; parent: own children. Filters `status`, `familyId`, `teacherId`, `courseId`; sort `id | name       | createdAt` |
| GET    | `/students/:id`                                                | any of `families.view`, `sessions.conduct`               | same scope, 404 outside it                                                                                                         |
| POST   | `/students`                                                    | `families.manage`                                        | `createStudentSchema`; family not archived/deactivated, teacher active                                                             |
| PATCH  | `/students/:id`                                                | `families.manage`                                        | `updateStudentSchema`                                                                                                              |
| POST   | `/students/:id/status`                                         | `families.manage`                                        | `activeStatusChangeSchema`; reason for inactive                                                                                    |
| DELETE | `/students/:id`                                                | `families.manage`                                        | archive; only `inactive`                                                                                                           |
| POST   | `/students/:id/restore`                                        | `families.manage`                                        | 409 `family_archived` while the family is archived                                                                                 |
| GET    | `/teachers`                                                    | `staff.view`                                             | filters `status`, `courseId`; sort `id                                                                                             | name       | createdAt` |
| GET    | `/teachers/:id`                                                | `staff.view`                                             | `TeacherDetailDto` (`activeStudents`)                                                                                              |
| POST   | `/teachers`                                                    | `staff.manage`                                           | `createTeacherSchema`; makes the teacher login; rate in the pay currency (EGP)                                                     |
| PATCH  | `/teachers/:id`                                                | `staff.manage`                                           | `updateTeacherSchema`; `courseIds` replaces the list                                                                               |
| POST   | `/teachers/:id/status`                                         | `staff.manage`                                           | 409 `teacher_has_students` (+ `data.activeStudents`) while active students remain                                                  |
| DELETE | `/teachers/:id`                                                | `staff.manage`                                           | archive; only `inactive`; login closed                                                                                             |
| POST   | `/teachers/:id/restore`                                        | `staff.manage`                                           | login reopened                                                                                                                     |
| GET    | `/staff`                                                       | `users.view`                                             | users of kind owner/staff; filters `status`, `role`; sort `name                                                                    | id         | createdAt` |
| GET    | `/staff/:id`                                                   | `users.view`                                             |                                                                                                                                    |
| POST   | `/staff`                                                       | `users.manage`                                           | `createStaffSchema`; owner role only by an owner; no role with more than the actor holds (403)                                     |
| PATCH  | `/staff/:id`                                                   | `users.manage`                                           | own role: 422 `cannot_change_own_role`; an owner only by an owner; last active owner kept (409 `last_admin`)                       |
| POST   | `/staff/:id/status`                                            | `users.manage`                                           | inactive: not yourself, not the last owner; signs them out everywhere                                                              |
| DELETE | `/staff/:id`                                                   | `users.manage`                                           | archive; only inactive, not yourself                                                                                               |
| POST   | `/staff/:id/restore`                                           | `users.manage`                                           | stays inactive                                                                                                                     |
| GET    | `/roles`                                                       | `roles.view`                                             | owner first, presets in matrix order, then custom; `editable`/`permissionsEditable` relative to the viewer                         |
| GET    | `/roles/catalog`                                               | `roles.view`                                             | `PermissionCatalog` (module/group/action labels + hints, ar + en)                                                                  |
| GET    | `/roles/:id`                                                   | `roles.view`                                             |                                                                                                                                    |
| POST   | `/roles`                                                       | `roles.manage`                                           | `createRoleSchema` (`permissions` or `copyFrom`); name `custom_<id>`                                                               |
| PATCH  | `/roles/:id`                                                   | `roles.manage`                                           | `updateRoleSchema`; owner role and portal roles: labels only (409); `customizedAt` set when permissions change                     |
| DELETE | `/roles/:id`                                                   | `roles.manage`                                           | 204; 409 `system_role` / `role_in_use`                                                                                             |

Refusal codes: `same_status` (422), `archived`, `must_deactivate_first`, `family_archived`,
`teacher_has_students`, `cannot_archive_self`, `last_admin`, `role_in_use`, `system_role`,
`owner_role_locked`, `cannot_edit_own_role`, `permission_not_held` (409; 403 for the two staff
assignment refusals), `not_archived`, `cannot_change_own_role`, `wrong_password` (422).

## Data model notes (N1)

- `families`, `students`, `teachers`: status + `status_reason/changed_at/changed_by`, history in
  `status_changes`, archive in `archived_at/by` + `archive_reason`. Contact data (name, email, phone)
  lives on the login (`users`) only.
- `courses` (minimal), `teacher_courses`, `audit_logs`, `app_settings` (typed defaults in
  `src/settings/settings.service.ts`).
- Countries and time zones are not tables: ISO codes and IANA names validated in `@qarabic/shared`.

## Endpoints (N2: schedule and classes)

Ported from the Laravel M2 routes (`api_v1.php`) with the same permissions. Contract in
`@qarabic/shared` (`schedule.ts`, `sessions.ts`, `requests.ts`). Row scope (D138): a teacher sees
only their own enrollments, classes, timetable and requests; a parent only their children's; a row
outside the scope answers 404.

| Method                | Path                                          | Permission                                                   | Notes                                                                                                                                                                             |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET                   | `/enrollments`                                | any of `schedule.view`, `sessions.conduct`                   | scoped; filters `studentId`, `teacherId`, `courseId`, `status`, `q` (student / teacher name); `meta.counts` per status; `externalMeetingUrl` + `notes` for `schedule.manage` only |
| GET                   | `/enrollments/:id`                            | any of `schedule.view`, `sessions.conduct`                   | `EnrollmentDetailDto` (+ `upcomingSessions`, 20)                                                                                                                                  |
| POST                  | `/enrollments`                                | `schedule.manage`                                            | `createEnrollmentSchema`; zone = family's; 422 `courseId` when a live one exists; 422 `meetingMode` for Zoom while `ZOOM_DRIVER=none`                                             |
| PATCH                 | `/enrollments/:id`                            | `schedule.manage`                                            | `updateEnrollmentSchema`; a new teacher versions every live slot from `effectiveFrom`; `{ data, affectedManualSessions }`; a meeting change updates future classes' links         |
| POST                  | `/enrollments/:id/pause` · `/resume` · `/end` | `schedule.manage`                                            | 409 `conflict` once ended; history in `status_changes`                                                                                                                            |
| POST                  | `/enrollments/:id/slots`                      | `schedule.manage`                                            | `addSlotSchema`                                                                                                                                                                   |
| PATCH                 | `/schedule-slots/:id`                         | `schedule.manage`                                            | `updateSlotSchema`: closes the slot the day before `effectiveFrom`, opens a version; `{ data, affectedManualSessions }`                                                           |
| POST                  | `/schedule-slots/:id/end`                     | `schedule.manage`                                            | `endSlotSchema`                                                                                                                                                                   |
| GET                   | `/schedule/availability`                      | `schedule.view` (staff only)                                 | `availabilityQuerySchema` → `AvailabilityDto`                                                                                                                                     |
| POST                  | `/schedule/check`                             | `schedule.view` (not a parent)                               | `scheduleCheckSchema` (slot or single class) → `ConflictResultDto`                                                                                                                |
| GET                   | `/teachers/:teacherId/timetable`              | any of `schedule.view`, `sessions.conduct`                   | own teacher only (else 404)                                                                                                                                                       |
| GET                   | `/teachers/:teacherId/blocks` · `/work-hours` | any of `schedule.view`, `sessions.conduct`                   | own teacher only                                                                                                                                                                  |
| POST · PATCH · DELETE | `/teachers/:teacherId/blocks[/:blockId]`      | `schedule.manage`                                            | re-syncs the teacher's classes                                                                                                                                                    |
| PUT                   | `/teachers/:teacherId/work-hours`             | any of `schedule.manage`, `sessions.conduct`                 | a teacher only their own (else 403)                                                                                                                                               |
| GET                   | `/holidays`                                   | `schedule.view`                                              | `?year=`                                                                                                                                                                          |
| POST · PATCH · DELETE | `/holidays[/:id]`                             | `schedule.manage`                                            | academy-local dates; re-syncs classes (cancel / restore)                                                                                                                          |
| GET                   | `/sessions`                                   | `sessions.view`                                              | `sessionListQuerySchema` (`date`+`tz`, `from`/`to`, `stage`, `kind`, `attention`, `perPage` ≤ 500); `meta.counts` per stage                                                       |
| GET                   | `/sessions/board`                             | `sessions.view`                                              | `BoardDto`; `since=cursor` deltas (removed rows included); weak `ETag` → 304                                                                                                      |
| POST                  | `/sessions/generate`                          | `schedule.manage`                                            | «مزامنة حصص اليوم»: `{ date, dryRun }` → `{ toCreate, created }`                                                                                                                  |
| POST                  | `/sessions`                                   | `sessions.manage`                                            | one-off class; 409 `schedule_conflict` / 422 `warnings_not_acknowledged`                                                                                                          |
| GET                   | `/sessions/:id`                               | `sessions.view`                                              | `SessionDetailDto` (events, requests, `lessonReport` — see N3)                                                                                                                    |
| PATCH                 | `/sessions/:id`                               | `sessions.manage`                                            | shift / change teacher of a scheduled class (detached); 409 `stale_session`                                                                                                       |
| POST                  | `/sessions/:id/transitions`                   | any of `sessions.conduct`, `sessions.manage`                 | `transitionSchema`; the state machine below                                                                                                                                       |
| GET                   | `/sessions/:id/zoom/start`                    | `sessions.conduct`                                           | own teacher, from 15 min before; never stored; `no-store`                                                                                                                         |
| GET                   | `/sessions/:id/zoom/join`                     | `sessions.view`                                              | from 60 min before; 503 `zoom_unavailable` without a link                                                                                                                         |
| POST                  | `/sessions/:id/zoom/retry`                    | `sessions.manage`                                            | failed / missing meeting of a scheduled class                                                                                                                                     |
| GET                   | `/session-requests`                           | `session_requests.view`                                      | scoped; `status` (+ `decided`), `type`, `studentId`, `mine`; `countOnly=1` → `RequestCountsDto`                                                                                   |
| GET                   | `/session-requests/:id`                       | `session_requests.view`                                      |                                                                                                                                                                                   |
| POST                  | `/session-requests`                           | any of `session_requests.request`, `session_requests.manage` | leave / reschedule / advance / extra; auto-approval rules in `requests.ts`                                                                                                        |
| POST                  | `/session-requests/:id/approve` · `/reject`   | `session_requests.approve`                                   | approve may change time / teacher (re-checked, 409 rolls back); reject needs `note`                                                                                               |
| POST                  | `/session-requests/:id/cancel`                | any of `session_requests.request`, `session_requests.manage` | requester only (else 403)                                                                                                                                                         |
| GET · PUT             | `/settings/sessions`                          | `settings.view` · `settings.manage`                          | flat keys (`SESSION_SETTING_RULES`); unknown key = 422 on it                                                                                                                      |
| GET · POST · PATCH    | `/zoom-hosts[/:id]`                           | `settings.manage`                                            | the Zoom host pool                                                                                                                                                                |

Class state machine (docs/14 §3.2): `activate` (from 10 min before to 30 min after the end;
staff `override` + `reason`; one running class per teacher), `undo_activate` (teacher 10 min),
`start`, `end` (teacher after 25 min; staff earlier with `reason` → `needsReview`),
`mark_absent` (25 min after the start, `note`), `mark_declined` (`note`), `mark_leave`
(`stageReason` student | teacher; a teacher needs 2 h notice via `notifiedAt`), `cancel` (staff,
`stageReason` from `CANCEL_REASONS`), `undo_mark` (the marker, 2 min), `revert` (staff, `reason`).
Windows come from `/settings/sessions`. Refusals: `invalid_transition` 409, `outside_window` 422
(`errors.availableFrom` / `availableUntil`), `stale_session` 409 (`data` = fresh class),
`forbidden` 403. Scheduling writes: `schedule_conflict` 409 and `warnings_not_acknowledged` 422
with the lists in `data` (resend the warning codes in `acknowledgeWarnings`).

## Endpoints (N3: teaching)

Ported from the Laravel M3 routes (`api_v1.php`, `api_v1_tests.php`) with the same permissions.
Contract in `@qarabic/shared` (`reports.ts`, `progress.ts`, `tests.ts`, `quran.ts`,
`teacher-portal.ts`). Same row scope as N2 (404 outside it).

| Method      | Path                            | Permission                                   | Notes                                                                                                                                                                                                                               |
| ----------- | ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUT         | `/sessions/:id/report`          | any of `sessions.conduct`, `sessions.manage` | `lessonReportInputSchema`; `ended` → `taken` (event `report_submitted`); on `taken` an edit (`report_updated`, audited): the class's teacher until `report.editableUntil`, staff always; 422 `outside_window`; answers `SessionDto` |
| GET         | `/sessions/:id/report`          | `sessions.view`                              | `LessonReportDto` or `data: null`; parents: no `teacherNotes` / authors / `editableUntil`; `rating` unless `reports.parent_sees_rating` is off (B30)                                                                                |
| GET         | `/lesson-reports`               | `sessions.view`                              | ended + taken classes with `state` `pending` · `missing` («بلا تقرير») · `on_time` · `late`; filters `state`, `from`/`to`, `teacherId`, `studentId`; `meta.counts` per state; teacher: own; parent 403                              |
| GET         | `/students/:id/progress`        | any of `families.view`, `sessions.conduct`   | `ProgressDto`: `lastPositions`, `timeline` (200, newest class first), `monthlyAyahs` (12 academy months), `coverage`; `from`/`to`/`type` filters                                                                                    |
| GET         | `/quran/surahs`                 | signed in                                    | 114 `SurahDto`; `Cache-Control: private, max-age=86400`                                                                                                                                                                             |
| GET         | `/tests`                        | `tests.view`                                 | `testListQuerySchema` (`status`, `month` academy zone, `date`, `from`/`to`, `teacherId`, `studentId`, `track`, `perPage` ≤ 100); scheduled first (soonest), then newest; `meta.counts` per status                                   |
| GET         | `/tests/summary`                | `tests.view`                                 | `?month=YYYY-MM`: tiles + `byTeacher` (scoped; parents 403)                                                                                                                                                                         |
| POST        | `/tests`                        | any of `tests.manage`, `tests.conduct`       | `createTestSchema`; teacher: own students, examiner = self; 422 `test_already_scheduled` / `no_examiner`                                                                                                                            |
| GET · PATCH | `/tests/:id`                    | `tests.view` · any of manage, conduct        | PATCH while scheduled: time / sections / notes / duration (examiner or staff), `teacherId` (staff)                                                                                                                                  |
| PUT         | `/tests/:id/result`             | any of `tests.manage`, `tests.conduct`       | `recordTestResultSchema` (checked after scope + action); from 30 min before (409 `test_not_started`); correction: examiner inside the edit window (409 `edit_window_closed`), staff with `reason` (422 `reason_required`)           |
| POST        | `/tests/:id/refuse` · `/cancel` | any of `tests.manage`, `tests.conduct`       | `reason`; cancel: staff or the examiner who scheduled it; 409 `invalid_test_status`                                                                                                                                                 |
| POST        | `/tests/:id/reopen`             | `tests.manage`                               | staff undo of refuse / cancel (`reason`); 422 `test_already_scheduled`                                                                                                                                                              |
| GET         | `/teacher-portal/week`          | `sessions.conduct` (teacher login only)      | «أسبوعي»: Saturday–Friday in the teacher's zone (`?date=` any day), `summary` + 7 `days`                                                                                                                                            |
| GET         | `/teacher-portal/students`      | `sessions.conduct` (teacher login only)      | «طلابي»: own students (no contact data), next class, last report, missing reports, last positions                                                                                                                                   |

`submit_report` is in `allowedActions` for an ended class (its teacher, staff) and for a taken one
inside the teacher's edit window (`sessions.report_edit_hours`, 48 h) or always for
`sessions.manage`. A class `ended` (or taken without a report) past `sessions.report_due_hours` is
flagged `report_missing`. Test errors: `TEST_ERROR_MESSAGES` (ar/en).

## Class jobs (N2)

`@nestjs/schedule` cron in the API process (`SCHEDULER_ENABLED=true`, one process only), in the
academy zone (`academy.timezone`, Africa/Cairo): `sessions:generate` hourly at :05 (horizon
`sessions.horizon_days`, idempotent, Postgres advisory lock), `session-requests:expire` hourly at
:15, `zoom:ensure-upcoming` every 10 min (no-op with `ZOOM_DRIVER=none`),
`sessions:audit-overlaps` daily at 03:10. The same jobs from the command line (after `build`):

```sh
pnpm --filter @qarabic/api cli sessions:generate [--from=YYYY-MM-DD --to=YYYY-MM-DD] [--enrollment=ID] [--dry-run]
pnpm --filter @qarabic/api cli session-requests:expire
pnpm --filter @qarabic/api cli zoom:ensure-upcoming
pnpm --filter @qarabic/api cli sessions:audit-overlaps [--days=30]   # exit 1 on overlaps
```

A schedule change (enrollment, slot, teacher, holiday, block, family / student status) re-syncs
future untouched generated classes right after it is saved (no queue), then fills gaps.

## Data model notes (N2)

- `enrollments` (partial unique index: one live per student + course), `schedule_slots` (weekday
  - local `HH:MM` + IANA zone, versioned by `valid_from/valid_to`), `holidays`, `teacher_blocks`,
    `teacher_work_hours`, `zoom_hosts`.
- `class_sessions`: `starts_at`/`ends_at` UTC, `kind` + `stage` (+ `stage_reason`), unique
  (`schedule_slot_id`, `occurrence_date`) including removed rows (`deleted_at`), `lock_version`.
- `session_events`: append-only timeline (a trigger refuses UPDATE / DELETE).
- `session_requests`: partial unique index, one pending per class + type.
- All "now" rules read the app `Clock` (tests pin it).

## Data model notes (N3)

- `lesson_reports` (one per class, `submitted_late` frozen at the first submission against
  `due_at`), `hifz_entries` (surah/ayah ranges with the computed `ayahs`, the class time in
  `lesson_at`; rewritten with the report), `student_tests` (partial unique index: one `scheduled`
  test per student + track; score CHECKs), `quran_surahs` (seeded by the migration; kept by the
  e2e table reset). Progress (last positions, coverage, monthly ayahs) is computed on read.

## Endpoints (N4: support centre «تواصل معنا» and the parent home)

Ported from the Laravel feedback / support routes (`api_v1_feedback.php`, docs/22, docs/32 S1–S2,
D99, D102, D135) with the same permissions. Contract in `@qarabic/shared` (`tickets.ts`,
`support.ts`, `portal.ts`). Visibility: a reporter sees their own tickets; `feedback.review` sees
all; queue members (`support.view` + their role in `support.queue_members`) see their queues;
`restricted` tickets (complaints) need `support.view_restricted` and are **never** shown to the
teacher they are about. A ticket the viewer may not see answers 404; an action they may not take
on one they see answers 403. `ANY` = any of `feedback.view|request|review|manage`,
`support.view|handle`.

| Method     | Path                             | Permission                                            | Notes                                                                                                                                                                                       |
| ---------- | -------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET        | `/feedback/summary`              | ANY                                                   | `{ mineUpdates, triageNew }` (`triageNew` null without `feedback.review`)                                                                                                                   |
| GET        | `/feedback/assignees`            | `feedback.manage`                                     | holders of `feedback.manage`                                                                                                                                                                |
| GET        | `/feedback/tickets`              | ANY                                                   | `ticketListQuerySchema`: `scope=mine\|all` (all = `feedback.review`, else 403), `status` (+ `open`/`closed`), `priority` (+ `none`), `type`, `category`, `queue`, `assigneeId`, `q`, `sort` |
| POST       | `/feedback/tickets`              | `feedback.request`                                    | JSON or multipart (`screenshot` + ≤ 3 `attachments`, PNG/JPEG/WebP ≤ 5 MB, sniffed); `createTicketSchema`; 10/h + 30/day per user (429)                                                     |
| GET        | `/feedback/tickets/:id`          | ANY                                                   | `TicketDetailDto` (timeline, files, `can`); internal rows / staff fields for staff only                                                                                                     |
| PATCH      | `/feedback/tickets/:id`          | any of `feedback.manage`, `support.handle`            | `updateTicketSchema`; lifecycle refusals are 422 on `status`, `note`, `priority`, `prUrl`, `assigneeId`, `duplicateOfId`                                                                    |
| POST       | `/feedback/tickets/:id/comments` | ANY                                                   | `createTicketCommentSchema` (+ multipart `attachments`); `internal` for managers only; closed → 422 `body` for the reporter; ≤ 10 files a ticket; 30/h                                      |
| POST       | `/feedback/tickets/:id/confirm`  | `feedback.request`                                    | reporter, on `fixed`: `resolved` → verified, else triaged with `body`                                                                                                                       |
| POST       | `/feedback/tickets/:id/seen`     | `feedback.request`                                    | 204; clears the «طلباتي» dot                                                                                                                                                                |
| GET        | `/feedback/attachments/:id`      | ANY                                                   | streams the file after the ticket policy; internal-note files staff only; 410 when pruned; `nosniff`, sandbox CSP, `private` cache                                                          |
| GET        | `/support/inbox`                 | `support.view`                                        | `inboxQuerySchema`; tickets of my queues + pending class requests («الجدولة»), breached first; `meta.queues`, `meta.counts` per queue                                                       |
| GET        | `/support/summary`               | `support.view`                                        | open / breached / unassigned totals + per queue                                                                                                                                             |
| GET        | `/support/assignees?queue=`      | any of `support.handle`, `support.manage`             | who may handle the queue; 422 for a queue I do not see                                                                                                                                      |
| GET        | `/support/people`                | `support.view`                                        | side panel (`familyId`, `teacherId`); family details need `families.view`                                                                                                                   |
| POST       | `/support/tickets/:id/take`      | any of `support.handle`, `support.manage`             | assign to me                                                                                                                                                                                |
| GET        | `/support/mine`                  | any of `feedback.request`, `session_requests.request` | «طلباتي»: my tickets + my class requests (a parent: also those on their children), open first; `meta.open`                                                                                  |
| GET · PUT  | `/settings/support`              | `settings.view` · `settings.manage`                   | `support.queue_by_category`, `support.queue_members`, `support.restricted_queues`, `support.sla_hours`, `support.working_hours`; unknown key = 422 on it                                    |
| GET · POST | `/webhooks/whatsapp`             | public (signed)                                       | 404 while `FEEDBACK_WHATSAPP_ENABLED=false` (default); GET = verify token; POST = `X-Hub-Signature-256` HMAC of the raw body (401)                                                          |
| GET        | `/parent/home`                   | `families.view`, parent only (else 403)               | `ParentHomeDto`: family, children (teacher, next class), next 7 days of classes, counters; `recentReports`: last 3 lesson reports per child (no internal note; rating per B30)              |

Lifecycle (docs/22 §3, D97): `new → triaged | in_progress | needs_info | wont_fix`, `triaged →
in_progress | needs_info | fixed | wont_fix`, `in_progress → triaged | needs_info | fixed |
wont_fix`, `needs_info → triaged | in_progress | wont_fix`, `fixed → verified | triaged |
in_progress`, closed → `triaged`. needs_info / wont_fix need a `note`; triaged / in_progress / fixed
need a priority; a technical fix needs its `prUrl` (`github.com/qarabicacademy/…/pull/N`). A
reporter's reply on needs_info moves it back to triaged. Routing: category (or
`category.subcategory`) → queue from the settings; a teacher complaint goes to the restricted
`complaints` queue. SLA: first response within `support.sla_hours[queue]` working hours
(Saturday–Thursday 10:00–22:00 Cairo), capped by the class start; the first public staff answer
stops it. Non-technical tickets start at P2, a complaint or a class within 24 h at P1.

Files: private storage behind `FileStorage` (`STORAGE_DRIVER=local`, `STORAGE_LOCAL_DIR`; S3 /
Spaces later), random keys `tickets/{id}/{uuid}.{ext}`, sha256 recorded.

## Ticket CLI (N4)

Claude works the queue from the server (docs/22 §7); writes go through the same service as the API
and are recorded as "Claude" (or `--as=`):

```sh
pnpm --filter @qarabic/api cli tickets:list [--status=open|closed|all|<status>,…] [--priority=p0,…,none] [--category=] [--queue=] [--json]
pnpm --filter @qarabic/api cli tickets:show <id> [--json] [--attachments=/tmp/ticket-<id>]
pnpm --filter @qarabic/api cli tickets:status <id> [--status=] [--priority=] [--note=] [--pr=] [--resolution=] [--assign=email|none]
pnpm --filter @qarabic/api cli tickets:reply <id> --body="…" [--internal]
```

## Data model notes (N4)

- `tickets` (category, subcategory, subject type + id, queue, visibility, family / teacher it
  concerns, SLA due / first response, priority, status + lifecycle dates, reporter, assignee, PR,
  sanitised context, WhatsApp contact encrypted + HMAC), `ticket_comments` (timeline rows:
  comment / status / priority / assignment / system, `internal`), `ticket_attachments`,
  `whatsapp_inbound_messages` (one row per Meta message id).
- Queues, their member roles, restricted queues, SLA targets and the working week are settings
  (`support.*` in `app_settings`), as in Laravel.

## Endpoints (N5: CRM — leads, trial, conversion, public intake)

Ported from the Laravel M4 CRM + Leads T1 (`api_v1_crm.php`, the public routes of `api_v1.php`)
with the same permissions (docs/26, docs/33 §3; D105–D111, D136, D137, D140). Contract in
`@qarabic/shared` (`crm.ts`). Every staff member with `leads.view` sees every lead (D108).

| Method    | Path                        | Permission                                             | Notes                                                                                                                                                                                                                                            |
| --------- | --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET       | `/leads`                    | `leads.view`                                           | `leadListQuerySchema`: `status` (`open` default, `all`, or one), `q` (name / email / phone digits ≥ 4 / id), `assigned` (`me`, `none`, id), `source`, `followUp=due` + `tz`, `awaitingOutcome`, `uncontacted`; `meta.counts` per status + `open` |
| GET       | `/leads/summary`            | `leads.view`                                           | today tiles in `tz` (else the viewer's zone): new, follow-ups due, trials today, awaiting outcome, converted / lost this month, open, unassigned, uncontacted, first-response overdue                                                            |
| GET       | `/leads/funnel`             | `leads.view`                                           | `from`/`to` (academy dates, ≤ 366 days else 422 `range_too_long`): created / contacted / trial / converted / lost / spam, by source and by assignee                                                                                              |
| GET       | `/leads/assignees`          | `leads.view`                                           | active `leads.manage` holders + open-lead count                                                                                                                                                                                                  |
| POST      | `/leads`                    | `leads.manage`                                         | `createLeadSchema` (manual sources only; phone or email); assigned to the creator unless `assignedTo` (someone else: `leads.assign`, else 403); never merged — duplicates show on the workbench                                                  |
| GET       | `/leads/:id`                | `leads.view`                                           | `LeadDetailDto`: timeline (200), trials (both local times), family students + live enrollments, duplicates, `allowedActions`, unanswered-attempt streak                                                                                          |
| PATCH     | `/leads/:id`                | `leads.manage`                                         | `updateLeadSchema`: contact data, children, `nextFollowUpAt`                                                                                                                                                                                     |
| POST      | `/leads/:id/activities`     | `leads.manage`                                         | note / call (`callResult` required) / whatsapp / email; a contact sets `firstResponseAt`, counts the attempt, moves `new` → `contacted`; optional `nextFollowUpAt`                                                                               |
| POST      | `/leads/:id/assign`         | `leads.manage`                                         | `{ userId \| null }`: take a free lead or release your own; anyone else needs `leads.assign` (403); 422 `userId` when the person cannot work leads                                                                                               |
| POST      | `/leads/bulk/assign`        | `leads.assign`                                         | `{ ids ≤ 100, userId }` → `{ updated, failed: [{ id, code }] }`                                                                                                                                                                                  |
| POST      | `/leads/:id/status`         | `leads.manage`                                         | `lost` (+ `lostReason`) / `spam` / `job_applicant` (open leads; cancel the booked trial), `reopen` (parked only), `contacted` (new only); else 422 `invalid_transition`                                                                          |
| POST      | `/leads/bulk/status`        | `leads.manage`                                         | `lost` / `spam` only, per-row result                                                                                                                                                                                                             |
| POST      | `/leads/:id/account`        | `leads.manage` + `families.manage`                     | trial family + parent login (random password, no mail) + children; 409 `already_has_family`; 422 `email_taken` + `data.familyId` (resend with `familyId` to add the children to that family)                                                     |
| POST      | `/leads/:id/trials`         | `leads.manage` + `schedule.manage`                     | `bookTrialSchema` in the family's wall time (DST gap / past → 422 `localTime`); conflicts like N2 (409 / 422 warnings); rebook moves the earlier trial out; `meta.trial` with both local times                                                   |
| POST      | `/leads/:id/trial-outcome`  | `leads.manage`                                         | interested → `trial_done`, no_show → `contacted`, not_interested → `lost` (cancels the booked trial)                                                                                                                                             |
| POST      | `/leads/:id/convert`        | `leads.manage` + `families.manage` + `schedule.manage` | one transaction (D110): regular enrollment + weekly slots per student, trial enrollment ends the day before, family `regular`, lead `converted`; `meta.enrollmentIds`; `sendWelcome: true` mails a set-password link                             |
| POST      | `/me/referrals`             | `leads.refer`                                          | a parent recommends a friend (10/hour per parent); `{ data: { received: true } }` whether new or merged                                                                                                                                          |
| GET · PUT | `/settings/crm`             | `settings.view` · `settings.manage`                    | `crm.*` flat keys (`CRM_SETTING_RULES`)                                                                                                                                                                                                          |
| GET       | `/public/courses`           | public                                                 | active courses: id, names, category (60/min per IP)                                                                                                                                                                                              |
| POST      | `/public/trial-requests`    | public, no CSRF                                        | the app's trial form (`publicTrialRequestSchema`); honeypot `website` → 200 and nothing stored; captcha when `FORMS_CAPTCHA_DRIVER=turnstile`; 5/min per IP; 201 `{ received: true }`                                                            |
| POST      | `/public/web-leads/wpforms` | public, no CSRF, signed                                | the website webhook (below)                                                                                                                                                                                                                      |
| POST      | `/api/class-request`        | public, no CSRF                                        | the developer's old form endpoint, same URL and field names (`Name`, `Email`, `Phone`, `Country`, …), always 200 `{ success: true }` (D105)                                                                                                      |

Refusal codes: `invalid_transition` (422), `already_has_family` (409), `email_taken`, `no_family`,
`already_enrolled`, `range_too_long`, `unknown_form`, `captcha_failed` (422), `forbidden` (403),
`invalid_signature` (401), `webhook_disabled` (503), `too_many_requests` (429), plus the N2
`schedule_conflict` (409) / `warnings_not_acknowledged` (422) from the trial and conversion.

### Website webhook contract (WordPress snippet, unchanged at cut-over)

`POST /api/v1/public/web-leads/wpforms`, JSON body built by the snippet
(`docs/integrations/wpforms-webhook.php` in the Laravel repo):
`{ form_id, entry_id, submitted_at, page_url, referer, fields: { name, email, phone, course_for,
children_count, student_age, course, notes } }` — WPForms field ids on form 4823: 1 name, 3 email,
5 phone, 11 «Course for», 12 children count, 13 age, 10 course, 9 notes.

- `X-Qarabic-Timestamp`: unix seconds, within 300 s of the server clock (401 otherwise).
- `X-Qarabic-Signature`: `sha256=` + hex `HMAC_SHA256(WEB_LEADS_WEBHOOK_SECRET, "{timestamp}.{raw body}")`,
  compared in constant time over the raw bytes (the API keeps `rawBody`). Bad / missing → 401
  `invalid_signature`; no secret configured → 503 `webhook_disabled`.
- Forms allowed: `WEB_LEADS_WPFORMS_FORM_IDS` (default `4823`), else 422 `unknown_form`.
- Replay protection / idempotency: the entry is keyed `wpforms:<form>:<entry>` (`leads.external_ref`,
  unique, or the `resubmitted` entry of a merged duplicate) under an advisory lock: a replay
  answers 200 `{ received: true, duplicate: true }`; a new entry 201 `duplicate: false`.
- Course label → course: `WEB_LEADS_COURSE_MAP` (JSON, lower-case labels), then an exact course
  name, else kept as text in `courseInterest`. Country from the phone's calling code; zone from
  the country. 30 calls/min per IP. No message to the family unless `crm.web_lead_confirmation`.

### Intake rules (D107, T1)

- Spam score (links / HTML, SQL, odd name, bad email, no contact, > 3 submissions an hour from the
  same IP hash) ≥ 50 → `spam` (own tab, never assigned); the answer is the same.
- Same email or phone digits on an open lead created in the last 30 days → merged (`submissions`
  +1, blank fields filled, a `resubmitted` entry), never a second lead.
- New non-spam leads are auto-assigned (D136/D137): round-robin by user id over active
  `leads.manage` holders of `crm.auto_assign_roles` (default `csr`) on shift (`crm.shift_source`:
  `any` default, `hours` = inside the CRM working hours, `attendance` = nobody until staff
  attendance exists in N6), else `crm.lead_admin_user_id`, else the `leads.assign` holders are told.
- Staff alerts (`notifications` row for the bell + an email to the staff member, parent name only):
  `assigned`, `unassigned`, `follow_up_due` (once per follow-up time), `sla_breach` (no contact
  within `crm.first_response_minutes` working minutes, 10:00–22:00 Cairo; leads of the last 3 days).
- Families get nothing by default (D140): `crm.trial_form_confirmation` and
  `crm.web_lead_confirmation` are off; the conversion welcome (set-password link) only with
  `sendWelcome: true`.

## CRM job (N5)

`leads:notify` every 5 minutes in the API process (`SCHEDULER_ENABLED`), idempotent (each alert is
claimed with a conditional update first). From the command line (after `build`):

```sh
pnpm --filter @qarabic/api cli leads:notify
```

## Data model notes (N5)

- `leads` (status, source, contact as submitted + `phone_digits`, children JSON, preferences,
  `external_ref` unique, family / referral family / owner / creator / converter, follow-up and SLA
  stamps, spam score + flags, salted IP hash, `submissions`), `lead_activities` (append-only: a
  trigger refuses UPDATE / DELETE), `notifications` (in-app alerts per user).
- A referral is a lead with `source=referral` + `referral_family_id`. A lead's trials are the
  `kind=trial` classes of its family's students (as in Laravel); the trial enrollment is
  `kind=trial` and ends when the student converts (past trial classes keep their kind, D110).
