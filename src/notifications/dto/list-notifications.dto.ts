import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEventType,
} from '../notification.types';

export class ListNotificationsDto {
  @IsOptional()
  @IsIn(NOTIFICATION_EVENT_TYPES)
  eventType?: NotificationEventType;

  @Transform(
    ({ value }: { value: unknown }) => value === true || value === 'true',
  )
  @IsBoolean()
  unreadOnly = false;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
