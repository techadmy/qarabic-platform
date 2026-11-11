import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccountsService } from './accounts.service.js';
import { FamiliesService } from './families.service.js';
import { LookupsService } from './lookups.service.js';
import {
  FamiliesController,
  LookupsController,
  StaffController,
  StudentsController,
  TeachersController,
} from './people.controllers.js';
import { StaffService } from './staff.service.js';
import { StudentsService } from './students.service.js';
import { TeachersService } from './teachers.service.js';

/** People (N1): families, students, teachers, staff and the form lookups (docs/28, D122–D130). */
@Module({
  imports: [AuthModule],
  controllers: [
    LookupsController,
    FamiliesController,
    StudentsController,
    TeachersController,
    StaffController,
  ],
  providers: [
    AccountsService,
    FamiliesService,
    StudentsService,
    TeachersService,
    StaffService,
    LookupsService,
  ],
  exports: [StaffService],
})
export class PeopleModule {}
