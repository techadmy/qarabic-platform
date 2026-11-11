import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Res } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import {
  createTestSchema,
  type Paginated,
  type ProgressDto,
  progressQuerySchema,
  recordTestResultSchema,
  type SurahDto,
  type TeacherStudentDto,
  type TeacherWeekDto,
  teacherWeekQuerySchema,
  type TestDto,
  testListQuerySchema,
  testReasonSchema,
  type TestStatus,
  type TestSummaryDto,
  testSummaryQuerySchema,
  updateTestSchema,
} from '@qarabic/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Authenticated, Can, CanAny, CurrentUser } from '../auth/decorators.js';
import { RateLimit } from '../auth/rate-limit.guard.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { ProgressService } from './progress.service.js';
import { TeacherPortalService } from './teacher-portal.service.js';
import { type TestAbility, TestsService } from './tests.service.js';

type Out<S extends z.ZodType> = z.output<S>;

/** Student progress and the Quran reference (docs/14 §8.2; Laravel `ProgressController`). */
@ApiTags('teaching')
@Controller()
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}

  /** Staff with `families.view`, a teacher their own students, a parent their own children. */
  @CanAny('families.view', 'sessions.conduct')
  @Get('students/:id/progress')
  async show(
    @Param('id', IdPipe) id: number,
    @ZodQuery(progressQuerySchema) q: Out<typeof progressQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: ProgressDto }> {
    return { data: await this.progress.progress(id, q, viewer) };
  }

  /** The 114 surahs (reference data for any signed-in user; cacheable for a day). */
  @Authenticated()
  @Get('quran/surahs')
  async surahs(@Res({ passthrough: true }) res: Response): Promise<{ data: SurahDto[] }> {
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return { data: await this.progress.surahs() };
  }
}

/**
 * `/tests` (docs/27 §7, D113–D119; Laravel `routes/api_v1_tests.php`). Row scope: staff all, a
 * teacher the tests they examine and their students' tests, a parent their children's
 * (no cancelled); out of scope = 404 before any action check (403).
 */
@ApiTags('teaching')
@Controller('tests')
export class TestsController {
  constructor(private readonly tests: TestsService) {}

  @Can('tests.view')
  @RateLimit('search')
  @Get()
  list(
    @ZodQuery(testListQuerySchema) q: Out<typeof testListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<TestDto>> {
    return this.tests.list(q, viewer);
  }

  @Can('tests.view')
  @Get('summary')
  async summary(
    @ZodQuery(testSummaryQuerySchema) q: Out<typeof testSummaryQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TestSummaryDto }> {
    return { data: await this.tests.summary(q.month, viewer) };
  }

  @CanAny('tests.manage', 'tests.conduct')
  @Post()
  @ApiBody({ schema: jsonSchema(createTestSchema) })
  async create(
    @ZodBody(createTestSchema) body: Out<typeof createTestSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: TestDto }> {
    const id = await this.tests.create(body, by);
    return { data: await this.tests.show(id, by) };
  }

  @Can('tests.view')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TestDto }> {
    return { data: await this.tests.show(id, viewer) };
  }

  /** While scheduled: time, sections, notes, duration (examiner or staff); the examiner (staff). */
  @CanAny('tests.manage', 'tests.conduct')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateTestSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateTestSchema) body: Out<typeof updateTestSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: TestDto }> {
    await this.tests.update(await this.tests.find(id, by, 'update'), body, by);
    return { data: await this.tests.show(id, by) };
  }

  /** Record or correct the result; the body is checked after the scope and the action. */
  @CanAny('tests.manage', 'tests.conduct')
  @Put(':id/result')
  @ApiBody({ schema: jsonSchema(recordTestResultSchema) })
  async result(
    @Param('id', IdPipe) id: number,
    @Body() body: unknown,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: TestDto }> {
    await this.tests.record(await this.tests.find(id, by, 'record'), body, by);
    return { data: await this.tests.show(id, by) };
  }

  @CanAny('tests.manage', 'tests.conduct')
  @Post(':id/refuse')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(testReasonSchema) })
  refuse(
    @Param('id', IdPipe) id: number,
    @ZodBody(testReasonSchema) body: Out<typeof testReasonSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: TestDto }> {
    return this.decide(id, 'refuse', 'refused', body.reason, by);
  }

  @CanAny('tests.manage', 'tests.conduct')
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(testReasonSchema) })
  cancel(
    @Param('id', IdPipe) id: number,
    @ZodBody(testReasonSchema) body: Out<typeof testReasonSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: TestDto }> {
    return this.decide(id, 'cancel', 'cancelled', body.reason, by);
  }

  /** Undo of refuse / cancel (staff). */
  @Can('tests.manage')
  @Post(':id/reopen')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(testReasonSchema) })
  reopen(
    @Param('id', IdPipe) id: number,
    @ZodBody(testReasonSchema) body: Out<typeof testReasonSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: TestDto }> {
    return this.decide(id, 'reopen', 'scheduled', body.reason, by);
  }

  private async decide(
    id: number,
    ability: TestAbility,
    to: TestStatus,
    reason: string,
    by: AuthUser,
  ): Promise<{ data: TestDto }> {
    await this.tests.decide(await this.tests.find(id, by, ability), to, reason, by);
    return { data: await this.tests.show(id, by) };
  }
}

/** The teacher portal (D71): a signed-in teacher's week and students (staff 403). */
@ApiTags('teaching')
@Controller('teacher-portal')
export class TeacherPortalController {
  constructor(private readonly portal: TeacherPortalService) {}

  @Can('sessions.conduct')
  @Get('week')
  async week(
    @ZodQuery(teacherWeekQuerySchema) q: Out<typeof teacherWeekQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TeacherWeekDto }> {
    return { data: await this.portal.week(viewer, q.date) };
  }

  @Can('sessions.conduct')
  @Get('students')
  async students(@CurrentUser() viewer: AuthUser): Promise<{ data: TeacherStudentDto[] }> {
    return { data: await this.portal.students(viewer) };
  }
}
