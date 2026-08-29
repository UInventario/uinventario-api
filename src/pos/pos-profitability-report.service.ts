import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PosProfitabilityReportDto } from './dto/pos-profitability-report.dto';
import { PosProfitabilityReportRepository } from './pos-profitability-report.repository';

@Injectable()
export class PosProfitabilityReportService {
  constructor(private readonly reports: PosProfitabilityReportRepository) {}

  async report(input: {
    tenantId: string;
    userId: string;
    administrator: boolean;
    query: PosProfitabilityReportDto;
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
