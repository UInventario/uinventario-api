import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEventType,
  type NotificationFrequency,
} from '../notification.types';

export class NotificationPreferenceInputDto {
  @IsUUID()
  recipientUserId!: string;

  @IsIn(NOTIFICATION_EVENT_TYPES)
  eventType!: NotificationEventType;

  @IsBoolean()
  enabled = true;

  @IsBoolean()
  inApp = true;

  @IsBoolean()
  email = false;

  @IsBoolean()
  push = false;

  @IsIn(['IMMEDIATE', 'DAILY_DIGEST'])
  frequency: NotificationFrequency = 'IMMEDIATE';
}

export class ReplaceNotificationPreferencesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceInputDto)
  preferences!: NotificationPreferenceInputDto[];
}
