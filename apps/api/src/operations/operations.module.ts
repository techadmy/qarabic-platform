import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AnnouncementsService } from './announcements.service.js';
import { DashboardService } from './dashboard.service.js';
import { OperationsJobs } from './jobs.js';
import {
  AnnouncementsController,
  DashboardController,
  NotificationPreferencesController,
  TasksController,
  TaskTemplatesController,
} from './operations.controllers.js';
import { ClassReminderService } from './reminders.service.js';
import { TasksService } from './tasks.service.js';

/**
 * Internal operations (M8; docs/09 M16–M18): tasks and templates, announcements, notification
 * preferences, class reminders and the dashboard numbers. The notification centre itself is the
 * global `NotificationCentreModule` so any module can send a notice. Complaints are the N4 support
 * centre (restricted `complaints` queue).
 */
@Module({
  imports: [AuthModule],
  controllers: [
    TasksController,
    TaskTemplatesController,
    AnnouncementsController,
    NotificationPreferencesController,
    DashboardController,
  ],
  providers: [
    TasksService,
    AnnouncementsService,
    DashboardService,
    ClassReminderService,
    OperationsJobs,
  ],
  exports: [OperationsJobs, TasksService],
})
export class OperationsModule {}
