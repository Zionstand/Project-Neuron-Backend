import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

export class UpdatePreferencesDto {
  @IsOptional() @IsBoolean() emailOnCaptureActivity?: boolean;
  @IsOptional() @IsBoolean() emailOnVerification?: boolean;
  @IsOptional() @IsBoolean() emailOnMediaSync?: boolean;
}

// Every route here is scoped to the caller — there is no route that reads or
// writes another user's notifications, so no role gate beyond "signed in".
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @Req() req: any,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('take') take?: string,
  ) {
    return this.notifications.list(req.user.id, {
      unreadOnly: unreadOnly === 'true',
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get('unread-count')
  unreadCount(@Req() req: any) {
    return this.notifications.unreadCount(req.user.id);
  }

  @Get('preferences')
  getPreferences(@Req() req: any) {
    return this.notifications.getPreferences(req.user.id);
  }

  @Patch('preferences')
  updatePreferences(@Req() req: any, @Body() dto: UpdatePreferencesDto) {
    return this.notifications.updatePreferences(req.user.id, dto);
  }

  @Post('read-all')
  markAllRead(@Req() req: any) {
    return this.notifications.markAllRead(req.user.id);
  }

  @Patch(':id/read')
  markRead(@Req() req: any, @Param('id') id: string) {
    return this.notifications.markRead(req.user.id, id);
  }
}
