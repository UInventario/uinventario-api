import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  InventoryActivityMovementsDto,
  InventoryActivityReportDto,
} from './dto/inventory-activity-report.dto';
import { InventoryActivityReportRepository } from './inventory-activity-report.repository';

@Injectable()
export class InventoryActivityReportService {
  constructor(private readonly reports: InventoryActivityReportRepository) {}

  async report(input: {
    tenantId: string;
    userId: string;
    administrator: boolean;
    query: InventoryActivityReportDto;
  }) {
    this.validatePeriod(input.query);
    const report = await this.reports.report(input);
    if (!report) throw new NotFoundException();
    return {
      data: report,
      meta: {
        apiVersion: '1' as const,
        pagination: this.pagination(input.query, report.total),
      },
    };
  }

  async movements(input: {
    tenantId: string;
    userId: string;
    administrator: boolean;
    productId: string;
    query: InventoryActivityMovementsDto;
  }) {
    this.validatePeriod(input.query);
    const result = await this.reports.movements(input);
    if (!result) throw new NotFoundException();
    return {
      data: result.items,
      meta: {
        apiVersion: '1' as const,
        pagination: this.pagination(input.query, result.total),
      },
    };
  }

  private validatePeriod(query: { dateFrom?: string; dateTo?: string }) {
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      throw new BadRequestException({
        code: 'INVALID_REPORT_DATE_RANGE',
        message: 'La fecha inicial no puede ser posterior a la fecha final.',
      });
    }
  }

  private pagination(query: { page: number; pageSize: number }, total: number) {
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }
}
