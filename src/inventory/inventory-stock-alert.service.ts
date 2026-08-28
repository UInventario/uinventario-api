import { Injectable, NotFoundException } from '@nestjs/common';
import { ListStockAlertsDto } from './dto/list-stock-alerts.dto';
import { InventoryTargetNotFoundError } from './inventory.errors';
import { InventoryStockAlertRepository } from './inventory-stock-alert.repository';
import type { InventoryStockAlertListResponse } from './inventory-stock-alert.types';

const DEFAULT_THRESHOLD = '5.000';

@Injectable()
export class InventoryStockAlertService {
  constructor(private readonly alerts: InventoryStockAlertRepository) {}

  async list(
    tenantId: string,
    branchId: string,
    warehouseId: string,
    query: ListStockAlertsDto,
  ): Promise<InventoryStockAlertListResponse> {
    try {
      const result = await this.alerts.list(
        tenantId,
        branchId,
        warehouseId,
        query,
      );
      return {
        data: result.items,
        meta: {
          apiVersion: '1',
          defaultThreshold: DEFAULT_THRESHOLD,
          scope: result.scope,
          pagination: {
            page: query.page,
            pageSize: query.pageSize,
            total: result.total,
            totalPages: Math.ceil(result.total / query.pageSize),
          },
        },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      throw error;
    }
  }

  async setThreshold(input: {
    tenantId: string;
    warehouseId: string;
    productId: string;
    locationId: string;
    threshold: string;
  }) {
    try {
      return {
        data: await this.alerts.setThreshold(input),
        meta: { apiVersion: '1' as const, defaultThreshold: DEFAULT_THRESHOLD },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      throw error;
    }
  }
}
