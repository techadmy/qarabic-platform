import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SessionReads } from '../sessions/board.js';
import { SessionGenerator } from '../sessions/generator.js';
import { SessionJobs } from '../sessions/jobs.js';
import { SessionPresenter } from '../sessions/presenter.js';
import { SessionRequestsService } from '../sessions/requests.service.js';
import { ResyncService } from '../sessions/resync.js';
import {
  SessionRequestsController,
  SessionSettingsController,
  SessionsController,
  ZoomHostsController,
} from '../sessions/sessions.controllers.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { SessionStateMachine } from '../sessions/state-machine.js';
import { ZoomDriver, ZoomMeetings } from '../sessions/zoom.js';
import { AvailabilityService } from './availability.service.js';
import { CalendarService } from './calendar.service.js';
import { ConflictChecker } from './conflicts.js';
import { EnrollmentsService } from './enrollments.service.js';
import {
  EnrollmentsController,
  HolidaysController,
  ScheduleSlotsController,
  ScheduleToolsController,
  TeacherScheduleController,
} from './schedule.controllers.js';

/**
 * Schedule and classes (N2): enrollments, weekly slots, holidays, teacher calendar, availability,
 * conflicts, the class generator and state machine, the Today board, class requests and meeting
 * links (docs/14, docs/04, docs/10). One module: the schedule and the classes depend on each
 * other (a schedule change re-syncs classes; a class check reads the schedule).
 */
@Module({
  imports: [AuthModule],
  controllers: [
    EnrollmentsController,
    ScheduleSlotsController,
    ScheduleToolsController,
    HolidaysController,
    TeacherScheduleController,
    SessionsController,
    SessionRequestsController,
    SessionSettingsController,
    ZoomHostsController,
  ],
  providers: [
    ConflictChecker,
    EnrollmentsService,
    CalendarService,
    AvailabilityService,
    ZoomDriver,
    ZoomMeetings,
    SessionStateMachine,
    SessionPresenter,
    SessionGenerator,
    ResyncService,
    SessionsService,
    SessionReads,
    SessionRequestsService,
    SessionJobs,
  ],
  exports: [EnrollmentsService, ZoomDriver, SessionJobs, SessionGenerator],
})
export class ScheduleModule {}
