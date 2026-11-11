import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import {
  createRoleSchema,
  type PermissionCatalog,
  type RoleDto,
  updateRoleSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CurrentUser } from '../auth/decorators.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { RolesService } from './roles.service.js';

/** `/roles`: editable roles and permissions (docs/29 §2, D132). `roles.view` reads, `roles.manage` writes. */
@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Can('roles.view')
  @Get()
  async list(@CurrentUser() viewer: AuthUser): Promise<{ data: RoleDto[] }> {
    return { data: await this.roles.list(viewer) };
  }

  @Can('roles.view')
  @Get('catalog')
  catalog(): { data: PermissionCatalog } {
    return { data: this.roles.catalog() };
  }

  @Can('roles.view')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: RoleDto }> {
    return { data: await this.roles.find(id, viewer) };
  }

  @Can('roles.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createRoleSchema) })
  async create(
    @ZodBody(createRoleSchema) body: z.output<typeof createRoleSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: RoleDto }> {
    const id = await this.roles.create(body, actor);
    return { data: await this.roles.find(id, actor) };
  }

  @Can('roles.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateRoleSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateRoleSchema) body: z.output<typeof updateRoleSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: RoleDto }> {
    await this.roles.update(id, body, actor);
    return { data: await this.roles.find(id, actor) };
  }

  @Can('roles.manage')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', IdPipe) id: number, @CurrentUser() actor: AuthUser): Promise<void> {
    await this.roles.delete(id, actor);
  }
}
