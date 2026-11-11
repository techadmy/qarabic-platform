import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  activeStatusChangeSchema,
  archiveSchema,
  createFamilySchema,
  createStaffSchema,
  createStudentSchema,
  createTeacherSchema,
  type FamilyDetailDto,
  type FamilyDto,
  familyListQuerySchema,
  familyStatusChangeSchema,
  type Paginated,
  type PeopleLookups,
  type StaffDto,
  staffListQuerySchema,
  type StudentDetailDto,
  type StudentDto,
  studentListQuerySchema,
  type TeacherDetailDto,
  type TeacherDto,
  teacherListQuerySchema,
  updateFamilySchema,
  updateStaffSchema,
  updateStudentSchema,
  updateTeacherSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CanAny, CurrentUser } from '../auth/decorators.js';
import { RateLimit } from '../auth/rate-limit.guard.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { FamiliesService } from './families.service.js';
import { LookupsService } from './lookups.service.js';
import { StaffService } from './staff.service.js';
import { StudentsService } from './students.service.js';
import { TeachersService } from './teachers.service.js';

type Out<S extends z.ZodType> = z.output<S>;

@ApiTags('people')
@Controller('people')
export class LookupsController {
  constructor(private readonly lookups: LookupsService) {}

  @CanAny('families.manage', 'staff.manage', 'users.manage')
  @Get('lookups')
  @ApiOperation({ summary: 'Pickers for the People forms' })
  async get(@CurrentUser() viewer: AuthUser): Promise<{ data: PeopleLookups }> {
    return { data: await this.lookups.lookups(viewer) };
  }
}

/** Families: `families.view` reads (a parent: own family only), `families.manage` writes. */
@ApiTags('people')
@Controller('families')
export class FamiliesController {
  constructor(private readonly families: FamiliesService) {}

  @Can('families.view')
  @RateLimit('search')
  @Get()
  list(
    @ZodQuery(familyListQuerySchema) q: Out<typeof familyListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<FamilyDto>> {
    return this.families.list(q, viewer);
  }

  @Can('families.view')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: FamilyDetailDto }> {
    return { data: await this.families.show(id, viewer) };
  }

  @Can('families.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createFamilySchema) })
  async create(
    @ZodBody(createFamilySchema) body: Out<typeof createFamilySchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: FamilyDetailDto }> {
    const id = await this.families.create(body, actor);
    return { data: await this.families.show(id, actor) };
  }

  @Can('families.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateFamilySchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateFamilySchema) body: Out<typeof updateFamilySchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: FamilyDetailDto }> {
    await this.families.update(id, body, actor);
    return { data: await this.families.show(id, actor) };
  }

  @Can('families.manage')
  @Post(':id/status')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(familyStatusChangeSchema) })
  async status(
    @Param('id', IdPipe) id: number,
    @ZodBody(familyStatusChangeSchema) body: Out<typeof familyStatusChangeSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: FamilyDetailDto }> {
    await this.families.changeStatus(id, body, actor);
    return { data: await this.families.show(id, actor) };
  }

  @Can('families.manage')
  @Delete(':id')
  @ApiOperation({ summary: 'Archive ("delete") with a reason; only a deactivated family' })
  @ApiBody({ schema: jsonSchema(archiveSchema) })
  async archive(
    @Param('id', IdPipe) id: number,
    @ZodBody(archiveSchema) body: Out<typeof archiveSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: FamilyDetailDto }> {
    await this.families.archive(id, body.reason, actor);
    return { data: await this.families.show(id, actor) };
  }

  @Can('families.manage')
  @Post(':id/restore')
  @HttpCode(200)
  async restore(
    @Param('id', IdPipe) id: number,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: FamilyDetailDto }> {
    await this.families.restore(id, actor);
    return { data: await this.families.show(id, actor) };
  }
}

/**
 * Students: staff with `families.view`, a teacher for their own students (`sessions.conduct`,
 * D138) and a parent for their own children read; `families.manage` writes.
 */
@ApiTags('people')
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @CanAny('families.view', 'sessions.conduct')
  @RateLimit('search')
  @Get()
  list(
    @ZodQuery(studentListQuerySchema) q: Out<typeof studentListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<StudentDto>> {
    return this.students.list(q, viewer);
  }

  @CanAny('families.view', 'sessions.conduct')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: StudentDetailDto }> {
    return { data: await this.students.show(id, viewer) };
  }

  @Can('families.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createStudentSchema) })
  async create(
    @ZodBody(createStudentSchema) body: Out<typeof createStudentSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: StudentDetailDto }> {
    const id = await this.students.create(body, actor);
    return { data: await this.students.show(id, actor) };
  }

  @Can('families.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateStudentSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateStudentSchema) body: Out<typeof updateStudentSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: StudentDetailDto }> {
    await this.students.update(id, body, actor);
    return { data: await this.students.show(id, actor) };
  }

  @Can('families.manage')
  @Post(':id/status')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(activeStatusChangeSchema) })
  async status(
    @Param('id', IdPipe) id: number,
    @ZodBody(activeStatusChangeSchema) body: Out<typeof activeStatusChangeSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: StudentDetailDto }> {
    await this.students.changeStatus(id, body, actor);
    return { data: await this.students.show(id, actor) };
  }

  @Can('families.manage')
  @Delete(':id')
  @ApiBody({ schema: jsonSchema(archiveSchema) })
  async archive(
    @Param('id', IdPipe) id: number,
    @ZodBody(archiveSchema) body: Out<typeof archiveSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: StudentDetailDto }> {
    await this.students.archive(id, body.reason, actor);
    return { data: await this.students.show(id, actor) };
  }

  @Can('families.manage')
  @Post(':id/restore')
  @HttpCode(200)
  async restore(
    @Param('id', IdPipe) id: number,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: StudentDetailDto }> {
    await this.students.restore(id, actor);
    return { data: await this.students.show(id, actor) };
  }
}

/** Teachers: `staff.view` reads, `staff.manage` writes. A teacher never lists teachers (D138). */
@ApiTags('people')
@Controller('teachers')
export class TeachersController {
  constructor(private readonly teachers: TeachersService) {}

  @Can('staff.view')
  @RateLimit('search')
  @Get()
  list(
    @ZodQuery(teacherListQuerySchema) q: Out<typeof teacherListQuerySchema>,
  ): Promise<Paginated<TeacherDto>> {
    return this.teachers.list(q);
  }

  @Can('staff.view')
  @Get(':id')
  async show(@Param('id', IdPipe) id: number): Promise<{ data: TeacherDetailDto }> {
    return { data: await this.teachers.show(id) };
  }

  @Can('staff.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createTeacherSchema) })
  async create(
    @ZodBody(createTeacherSchema) body: Out<typeof createTeacherSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: TeacherDetailDto }> {
    const id = await this.teachers.create(body, actor);
    return { data: await this.teachers.show(id) };
  }

  @Can('staff.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateTeacherSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateTeacherSchema) body: Out<typeof updateTeacherSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: TeacherDetailDto }> {
    await this.teachers.update(id, body, actor);
    return { data: await this.teachers.show(id) };
  }

  @Can('staff.manage')
  @Post(':id/status')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(activeStatusChangeSchema) })
  async status(
    @Param('id', IdPipe) id: number,
    @ZodBody(activeStatusChangeSchema) body: Out<typeof activeStatusChangeSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: TeacherDetailDto }> {
    await this.teachers.changeStatus(id, body, actor);
    return { data: await this.teachers.show(id) };
  }

  @Can('staff.manage')
  @Delete(':id')
  @ApiBody({ schema: jsonSchema(archiveSchema) })
  async archive(
    @Param('id', IdPipe) id: number,
    @ZodBody(archiveSchema) body: Out<typeof archiveSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: TeacherDetailDto }> {
    await this.teachers.archive(id, body.reason, actor);
    return { data: await this.teachers.show(id) };
  }

  @Can('staff.manage')
  @Post(':id/restore')
  @HttpCode(200)
  async restore(
    @Param('id', IdPipe) id: number,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: TeacherDetailDto }> {
    await this.teachers.restore(id, actor);
    return { data: await this.teachers.show(id) };
  }
}

/** Staff (الموظفون, D130): `users.view` reads, `users.manage` writes. */
@ApiTags('people')
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Can('users.view')
  @RateLimit('search')
  @Get()
  list(
    @ZodQuery(staffListQuerySchema) q: Out<typeof staffListQuerySchema>,
  ): Promise<Paginated<StaffDto>> {
    return this.staff.list(q);
  }

  @Can('users.view')
  @Get(':id')
  async show(@Param('id', IdPipe) id: number): Promise<{ data: StaffDto }> {
    return { data: await this.staff.show(id) };
  }

  @Can('users.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createStaffSchema) })
  async create(
    @ZodBody(createStaffSchema) body: Out<typeof createStaffSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: StaffDto }> {
    const id = await this.staff.create(body, actor);
    return { data: await this.staff.show(id) };
  }

  @Can('users.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateStaffSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateStaffSchema) body: Out<typeof updateStaffSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: StaffDto }> {
    await this.staff.update(id, body, actor);
    return { data: await this.staff.show(id) };
  }

  @Can('users.manage')
  @Post(':id/status')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(activeStatusChangeSchema) })
  async status(
    @Param('id', IdPipe) id: number,
    @ZodBody(activeStatusChangeSchema) body: Out<typeof activeStatusChangeSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: StaffDto }> {
    await this.staff.changeStatus(id, body, actor);
    return { data: await this.staff.show(id) };
  }

  @Can('users.manage')
  @Delete(':id')
  @ApiBody({ schema: jsonSchema(archiveSchema) })
  async archive(
    @Param('id', IdPipe) id: number,
    @ZodBody(archiveSchema) body: Out<typeof archiveSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: StaffDto }> {
    await this.staff.archive(id, body.reason, actor);
    return { data: await this.staff.show(id) };
  }

  @Can('users.manage')
  @Post(':id/restore')
  @HttpCode(200)
  async restore(
    @Param('id', IdPipe) id: number,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: StaffDto }> {
    await this.staff.restore(id, actor);
    return { data: await this.staff.show(id) };
  }
}
