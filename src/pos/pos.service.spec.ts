import { PosRepository } from './pos.repository';
import { SalesRepository } from './sales.repository';
import { PosService } from './pos.service';
import { CashRegisterShiftService } from './cash-register-shift.service';

describe('PosService', () => {
  it('selects the tenant country tax rate without changing the final sale price', async () => {
    const repository = {
      getContext: jest.fn().mockResolvedValue({
        countryCode: 'CL',
        branch: { id: 'branch', name: 'Sucursal' },
        warehouse: { id: 'warehouse', name: 'Bodega' },
        cashRegister: { id: 'register', name: 'Caja', code: 'MAIN' },
      }),
      getProducts: jest.fn().mockResolvedValue([
        {
          id: '7efc799b-2086-4cb6-808d-bfa682543757',
          name: 'Producto',
          sku: 'PRODUCTO-1',
          price: '119.00',
          active: true,
          availableQuantity: '5.000',
        },
      ]),
      getSelectedLotAvailability: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new PosService(
      repository as unknown as PosRepository,
      {} as SalesRepository,
      {
        requireCurrent: jest.fn().mockResolvedValue({ id: 'shift' }),
      } as unknown as CashRegisterShiftService,
      { enabledMethods: jest.fn().mockReturnValue(['CASH']) } as never,
      { resolve: jest.fn().mockResolvedValue(new Map()) } as never,
      {
        taxRates: { MX: '0.1600', CL: '0.1900', DEFAULT: '0.0000' },
        nonCashProvider: 'DISABLED',
        paymentMethods: ['CASH'],
      },
    );

    const quote = await service.quoteCart({
      tenantId: 'tenant',
      branchId: 'branch',
      warehouseId: 'warehouse',
      cashRegisterId: 'register',
      userId: 'user',
      dto: {
        lines: [
          {
            productId: '7efc799b-2086-4cb6-808d-bfa682543757',
            quantity: '1',
          },
        ],
      },
    });

    expect(quote.data).toMatchObject({
      currency: 'CLP',
      taxRate: '0.1900',
      totals: { subtotal: '100.00', tax: '19.00', total: '119.00' },
    });
  });

  it('allocates a fixed sale discount exactly with deterministic cent rounding', async () => {
    const firstId = '7efc799b-2086-4cb6-808d-bfa682543757';
    const secondId = '6a5ec4cd-a854-4fb1-85d7-9ed7c98279c1';
    const repository = {
      getContext: jest.fn().mockResolvedValue({
        countryCode: 'US',
        branch: { id: 'branch', name: 'Sucursal' },
        warehouse: { id: 'warehouse', name: 'Bodega' },
        cashRegister: { id: 'register', name: 'Caja', code: 'MAIN' },
      }),
      getProducts: jest.fn().mockResolvedValue([
        {
          id: firstId,
          name: 'Producto uno',
          sku: 'UNO',
          price: '1.00',
          active: true,
          trackSerials: false,
          availableQuantity: '5.000',
        },
        {
          id: secondId,
          name: 'Producto dos',
          sku: 'DOS',
          price: '2.00',
          active: true,
          trackSerials: false,
          availableQuantity: '5.000',
        },
      ]),
      getSelectedLotAvailability: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new PosService(
      repository as unknown as PosRepository,
      {} as SalesRepository,
      {
        requireCurrent: jest.fn().mockResolvedValue({ id: 'shift' }),
      } as unknown as CashRegisterShiftService,
      { enabledMethods: jest.fn().mockReturnValue(['CASH']) } as never,
      { resolve: jest.fn().mockResolvedValue(new Map()) } as never,
      {
        taxRates: { US: '0.0000', DEFAULT: '0.0000' },
        nonCashProvider: 'DISABLED',
        paymentMethods: ['CASH'],
      },
    );

    const quote = await service.quoteCart({
      tenantId: 'tenant',
      branchId: 'branch',
      warehouseId: 'warehouse',
      cashRegisterId: 'register',
      userId: 'user',
      canDiscount: true,
      dto: {
        lines: [
          { productId: firstId, quantity: '1' },
          { productId: secondId, quantity: '1' },
        ],
        discount: {
          type: 'AMOUNT',
          value: '1.00',
          reason: 'Ajuste comercial',
        },
      },
    });

    expect(quote.data.lines.map((line) => line.discount.sale?.amount)).toEqual([
      '0.33',
      '0.67',
    ]);
    expect(quote.data.totals).toEqual({
      gross: '3.00',
      lineDiscount: '0.00',
      saleDiscount: '1.00',
      discount: '1.00',
      subtotal: '2.00',
      tax: '0.00',
      total: '2.00',
    });
  });
});
