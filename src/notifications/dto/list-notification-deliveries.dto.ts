import { IsIn, IsOptional } from 'class-validator';
import type { NotificationDeliveryStatus } from '../notification.types';

export class ListNotificationDeliveriesDto {
  @IsOptional()
  @IsIn(['PENDING', 'PROCESSING', 'SENT', 'FAILED'])
  status?: NotificationDeliveryStatus;
}
