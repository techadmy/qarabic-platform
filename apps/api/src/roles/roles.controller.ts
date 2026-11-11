import { Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { type RoleDto, updateRolePermissionsSchema } from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CurrentUser } from '../auth/decorators.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { RolesService } from './roles.service.js';

@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Can('roles.view')
  @Get()
  async list(): Promise<{ data: RoleDto[] }> {
    return { data: await this.roles.list() };
  }

  @Can('roles.view')
  @Get(':id')
  async show(@Param('id', IdPipe) id: number): Promise<{ data: RoleDto }> {
    return { data: await this.roles.find(id) };
  }

  @Can('roles.manage')
  @Put(':id/permissions')
  @ApiBody({ schema: jsonSchema(updateRolePermissionsSchema) })
  async updatePermissions(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateRolePermissionsSchema) body: z.output<typeof updateRolePermissionsSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: RoleDto }> {
    return { data: await this.roles.updatePermissions(id, body.permissions, actor) };
  }
}
