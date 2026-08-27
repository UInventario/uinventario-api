import { PosRepository } from './pos.repository';
import { PosService } from './pos.service';

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
    };
    const service = new PosService(repository as unknown as PosRepository, {
      taxRates: { MX: '0.1600', CL: '0.1900', DEFAULT: '0.0000' },
    });

    const quote = await service.quoteCart({
      tenantId: 'tenant',
      branchId: 'branch',
      warehouseId: 'warehouse',
      cashRegisterId: 'register',
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
});
