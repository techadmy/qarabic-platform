import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MeController } from './me.controller.js';
import { NotificationsController } from './notifications.controller.js';

@Module({ imports: [AuthModule], controllers: [MeController, NotificationsController] })
export class AccountModule {}
