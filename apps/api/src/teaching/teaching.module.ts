import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { ProgressService } from './progress.service.js';
import { TeacherPortalService } from './teacher-portal.service.js';
import {
  ProgressController,
  TeacherPortalController,
  TestsController,
} from './teaching.controllers.js';
import { TestsService } from './tests.service.js';

/**
 * Teaching (N3): student progress and the Quran reference, student tests and the teacher portal
 * (docs/14 §8, docs/27, D70–D72, D113–D120). The lesson report itself closes a class, so it lives
 * with the classes (`ScheduleModule`).
 */
@Module({
  imports: [AuthModule, ScheduleModule],
  controllers: [ProgressController, TestsController, TeacherPortalController],
  providers: [ProgressService, TestsService, TeacherPortalService],
})
export class TeachingModule {}
