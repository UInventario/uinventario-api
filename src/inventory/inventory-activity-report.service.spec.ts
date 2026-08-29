import { BadRequestException } from '@nestjs/common';
import { InventoryActivityReportService } from './inventory-activity-report.service';

describe('InventoryActivityReportService', () => {
  it('rejects an inverted reporting period before querying storage', async () => {
    const reports = { report: jest.fn(), movements: jest.fn() };
    const service = new InventoryActivityReportService(reports as never);

    await expect(
      service.report({
        tenantId: 'tenant-1',
        userId: 'user-1',
        administrator: true,
        query: {
          dateFrom: '2026-08-29',
          dateTo: '2026-08-01',
          page: 1,
          pageSize: 20,
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(reports.report).not.toHaveBeenCalled();
  });
});
