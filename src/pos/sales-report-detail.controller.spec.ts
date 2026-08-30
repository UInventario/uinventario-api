import type { AuthenticatedRequest } from '../auth/session/session.types';
import { PosService } from './pos.service';
import { SaleReturnService } from './sale-return.service';
import { SalesCashReportService } from './sales-cash-report.service';
import { SalesReportDetailController } from './sales-report-detail.controller';

describe('SalesReportDetailController', () => {
  const getSale = jest.fn();
  const list = jest.fn();
  const resolveSaleBranch = jest.fn().mockResolvedValue('branch-2');
  const controller = new SalesReportDetailController(
    { getSale } as unknown as PosService,
    { list } as unknown as SaleReturnService,
    { resolveSaleBranch } as unknown as SalesCashReportService,
  );
  const request = {
    principal: {
      tenant: { id: 'tenant-1' },
      user: {
        id: 'user-1',
        permissions: ['SALES_MANAGE', 'INVENTORY_VALUATION_MANAGE'],
      },
    },
  } as unknown as AuthenticatedRequest;

  beforeEach(() => jest.clearAllMocks());

  it('loads detail from the authorized report branch', async () => {
    getSale.mockResolvedValue({ data: { id: 'sale-1' } });
    await controller.detail(request, 'sale-1');
    expect(resolveSaleBranch).toHaveBeenCalled();
    expect(getSale).toHaveBeenCalledWith(
      'tenant-1',
      'branch-2',
      'sale-1',
      true,
    );
  });

  it('loads returns from the same authorized report branch', async () => {
    list.mockResolvedValue({ data: [] });
    await controller.saleReturns(request, 'sale-1');
    expect(list).toHaveBeenCalledWith('tenant-1', 'branch-2', 'sale-1');
  });
});
