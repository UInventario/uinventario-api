import { PromotionEngineService } from './promotion-engine.service';
import type { PromotionRepository } from './promotion.repository';
import type { PromotionData, PromotionType } from './promotion.types';

const product = (id: string) => ({ id, name: id, sku: `SKU-${id}` });

function rule(
  id: string,
  type: PromotionType,
  products: Array<{ id: string; quantity?: string }>,
  overrides: Partial<PromotionData> = {},
): PromotionData {
  return {
    id,
    name: id,
    type,
    scope: { branch: null, customer: null, channel: null },
    priority: 0,
    stackable: false,
    validFrom: '2026-08-01T00:00:00.000Z',
    validTo: null,
    active: true,
    discountPercent: null,
    fixedPrice: null,
    buyQuantity: null,
    rewardQuantity: null,
    version: 1,
    products: products.map((item) => ({
      product: product(item.id),
      quantity: item.quantity ?? '1.000',
    })),
    tiers: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PromotionEngineService', () => {
  it('calculates 2x1, second unit, bundles and quantity tiers', async () => {
    const applicable = jest.fn().mockResolvedValue([
      rule('2x1', 'BUY_X_GET_Y', [{ id: 'a' }], {
        buyQuantity: '1.000',
        rewardQuantity: '1.000',
        discountPercent: '100.0000',
      }),
      rule('second', 'SECOND_UNIT_PERCENT', [{ id: 'b' }], {
        discountPercent: '50.0000',
      }),
      rule('quantity', 'QUANTITY_PERCENT', [{ id: 'c' }], {
        tiers: [
          { minimumQuantity: '3.000', discountPercent: '10.0000' },
          { minimumQuantity: '5.000', discountPercent: '20.0000' },
        ],
      }),
      rule('bundle', 'BUNDLE_FIXED', [{ id: 'd' }, { id: 'e' }], {
        fixedPrice: '40.00',
      }),
    ]);
    const service = new PromotionEngineService({
      applicable,
    } as unknown as PromotionRepository);

    const result = await service.resolve({
      tenantId: 'tenant',
      branchId: 'branch',
      channel: 'POS',
      at: new Date('2026-08-29T12:00:00.000Z'),
      lines: [
        {
          productId: 'a',
          quantity: '2.000',
          unitPrice: '100.00',
          grossTotal: '200.00',
        },
        {
          productId: 'b',
          quantity: '2.000',
          unitPrice: '100.00',
          grossTotal: '200.00',
        },
        {
          productId: 'c',
          quantity: '5.000',
          unitPrice: '10.00',
          grossTotal: '50.00',
        },
        {
          productId: 'd',
          quantity: '1.000',
          unitPrice: '30.00',
          grossTotal: '30.00',
        },
        {
          productId: 'e',
          quantity: '1.000',
          unitPrice: '30.00',
          grossTotal: '30.00',
        },
      ],
    });

    expect(result.get('a')?.[0].amount).toBe('100.00');
    expect(result.get('b')?.[0].amount).toBe('50.00');
    expect(result.get('c')?.[0].amount).toBe('10.00');
    expect(result.get('d')?.[0].amount).toBe('10.00');
    expect(result.get('e')?.[0].amount).toBe('10.00');
    expect(result.get('c')?.[0].ruleSnapshot).toMatchObject({
      type: 'QUANTITY_PERCENT',
      tiers: [{ minimumQuantity: '3.000' }, { minimumQuantity: '5.000' }],
    });
  });

  it('applies only stackable rules together and honors repository priority order', async () => {
    const applicable = jest.fn().mockResolvedValue([
      rule('exclusive-high', 'QUANTITY_PERCENT', [{ id: 'a' }], {
        priority: 100,
        tiers: [{ minimumQuantity: '1.000', discountPercent: '10.0000' }],
      }),
      rule('stackable-low', 'QUANTITY_PERCENT', [{ id: 'a' }], {
        priority: 10,
        stackable: true,
        tiers: [{ minimumQuantity: '1.000', discountPercent: '5.0000' }],
      }),
      rule('stackable-one', 'QUANTITY_PERCENT', [{ id: 'b' }], {
        priority: 20,
        stackable: true,
        tiers: [{ minimumQuantity: '1.000', discountPercent: '10.0000' }],
      }),
      rule('stackable-two', 'QUANTITY_PERCENT', [{ id: 'b' }], {
        priority: 10,
        stackable: true,
        tiers: [{ minimumQuantity: '1.000', discountPercent: '5.0000' }],
      }),
    ]);
    const service = new PromotionEngineService({
      applicable,
    } as unknown as PromotionRepository);

    const result = await service.resolve({
      tenantId: 'tenant',
      branchId: 'branch',
      customerId: 'customer',
      channel: 'WEB',
      at: new Date('2026-08-29T12:00:00.000Z'),
      lines: [
        {
          productId: 'a',
          quantity: '1.000',
          unitPrice: '100.00',
          grossTotal: '100.00',
        },
        {
          productId: 'b',
          quantity: '1.000',
          unitPrice: '100.00',
          grossTotal: '100.00',
        },
      ],
    });

    expect(result.get('a')?.map(({ promotion }) => promotion.id)).toEqual([
      'exclusive-high',
    ]);
    expect(result.get('b')?.map(({ promotion }) => promotion.id)).toEqual([
      'stackable-one',
      'stackable-two',
    ]);
    expect(applicable).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'customer',
        channel: 'WEB',
        productIds: ['a', 'b'],
      }),
    );
  });
});
