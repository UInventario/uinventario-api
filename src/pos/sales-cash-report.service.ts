import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SalesCashReportDto } from './dto/sales-cash-report.dto';
import { SalesCashReportRepository } from './sales-cash-report.repository';

@Injectable()
export class SalesCashReportService {
  constructor(private readonly reports: SalesCashReportRepository) {}

  async report(input: {
    tenantId: string;
    userId: string;
    administrator: boolean;
    query: SalesCashReportDto;
  }) {
    if (
      input.query.dateFrom &&
      input.query.dateTo &&
      input.query.dateFrom > input.query.dateTo
    ) {
      throw new BadRequestException({
        code: 'INVALID_REPORT_DATE_RANGE',
        message: 'La fecha inicial no puede ser posterior a la fecha final.',
      });
    }
    const report = await this.reports.report(input);
    if (!report) throw new NotFoundException();
    return {
      data: report,
      meta: {
        apiVersion: '1' as const,
        pagination: {
          page: input.query.page,
          pageSize: input.query.pageSize,
          total: report.total,
          totalPages: Math.ceil(report.total / input.query.pageSize),
        },
        periodTimezone: 'BRANCH_LOCAL' as const,
      },
    };
  }
}
