import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ZoomApi, ZoomHttp } from './zoom.api.js';
import { ZoomAttendance } from './zoom.attendance.js';
import { ZoomConfig } from './zoom.config.js';
import { ZoomWebhookController } from './zoom.webhook.js';

/**
 * Z1 (docs/42 §6, D148): Zoom attendance with a Server-to-Server app. Off until the owner sets the
 * ZOOM_* keys (ZOOM_DRIVER=s2s). Global so the class presenter can read whether tracking is on.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [ZoomWebhookController],
  providers: [ZoomConfig, ZoomHttp, ZoomApi, ZoomAttendance],
  exports: [ZoomConfig, ZoomApi, ZoomAttendance],
})
export class ZoomModule {}
