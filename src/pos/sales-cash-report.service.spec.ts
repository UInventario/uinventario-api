import { NotFoundException } from '@nestjs/common';
import { SalesCashReportRepository } from './sales-cash-report.repository';
import { SalesCashReportService } from './sales-cash-report.service';

describe('SalesCashReportService', () => {
  const saleBranch = jest.fn();
  const repository = { saleBranch } as unknown as SalesCashReportRepository;
  const service = new SalesCashReportService(repository);
  const input = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    administrator: false,
    saleId: 'sale-1',
  };

  beforeEach(() => jest.clearAllMocks());

  it('resolves the branch of a sale visible to the report user', async () => {
    saleBranch.mockResolvedValue('branch-2');

    await expect(service.resolveSaleBranch(input)).resolves.toBe('branch-2');
    expect(saleBranch).toHaveBeenCalledWith(input);
  });

  it('does not reveal a sale outside the authorized branch scope', async () => {
    saleBranch.mockResolvedValue(null);

    await expect(service.resolveSaleBranch(input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
