import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryStockAlertRepository } from '../inventory/inventory-stock-alert.repository';
import type { ListNotificationDeliveriesDto } from './dto/list-notification-deliveries.dto';
import type { ListNotificationsDto } from './dto/list-notifications.dto';
import type { ReplaceNotificationPreferencesDto } from './dto/replace-notification-preferences.dto';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationRepository } from './notification.repository';
import { NOTIFICATION_EVENT_TYPES } from './notification.types';

@Injectable()
export class NotificationService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly stockAlerts: InventoryStockAlertRepository,
    private readonly deliveries: NotificationDeliveryService,
  ) {}

  async refresh(tenantId: string) {
    await this.stockAlerts.reconcileTenant(tenantId);
    const reconciliation = await this.notifications.reconcile(tenantId);
    const delivery = await this.deliveries.process(tenantId);
    return {
      data: { reconciliation, delivery },
      meta: { apiVersion: '1' as const },
    };
  }

  async list(tenantId: string, userId: string, query: ListNotificationsDto) {
    const result = await this.notifications.list(tenantId, userId, query);
    return {
      data: result.items,
      meta: {
        apiVersion: '1' as const,
        unread: result.unread,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: result.total,
          totalPages: Math.ceil(result.total / query.pageSize),
        },
      },
    };
  }

  async markRead(tenantId: string, userId: string, id: string) {
    const changed = await this.notifications.markRead(tenantId, userId, id);
    if (changed === 0) throw new NotFoundException();
    return { data: { id, read: true }, meta: { apiVersion: '1' as const } };
  }

  async markAllRead(tenantId: string, userId: string) {
    const changed = await this.notifications.markRead(tenantId, userId);
    return { data: { changed }, meta: { apiVersion: '1' as const } };
  }

  async preferences(tenantId: string) {
    const data = await this.notifications.listPreferences(tenantId);
    return {
      data,
      meta: {
        apiVersion: '1' as const,
        eventTypes: NOTIFICATION_EVENT_TYPES,
        adapters: { email: 'SIMULATOR', push: 'SIMULATOR' },
      },
    };
  }

  async replacePreferences(
    tenantId: string,
    dto: ReplaceNotificationPreferencesDto,
  ) {
    const unique = new Set<string>();
    for (const preference of dto.preferences) {
      const key = `${preference.recipientUserId}:${preference.eventType}`;
      if (unique.has(key))
        throw new BadRequestException('DUPLICATE_NOTIFICATION_PREFERENCE');
      unique.add(key);
      if (
        preference.enabled &&
        !preference.inApp &&
        !preference.email &&
        !preference.push
      ) {
        throw new BadRequestException('NOTIFICATION_CHANNEL_REQUIRED');
      }
    }
    try {
      return {
        data: await this.notifications.replacePreferences(
          tenantId,
          dto.preferences,
        ),
        meta: { apiVersion: '1' as const },
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'RECIPIENT_NOT_FOUND')
        throw new BadRequestException('NOTIFICATION_RECIPIENT_NOT_FOUND');
      throw error;
    }
  }

  async listDeliveries(tenantId: string, query: ListNotificationDeliveriesDto) {
    return {
      data: await this.notifications.listDeliveries(tenantId, query),
      meta: { apiVersion: '1' as const },
    };
  }

  async retryDeliveries(tenantId: string) {
    await this.notifications.retryFailed(tenantId);
    return {
      data: await this.deliveries.process(tenantId),
      meta: { apiVersion: '1' as const },
    };
  }
}
