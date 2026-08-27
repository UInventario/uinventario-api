import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { posConfig } from '../config/pos.config';
import { QuoteCartDto } from './dto/quote-cart.dto';
import {
  PosContextNotFoundError,
  PosInsufficientStockError,
  PosProductNotAvailableError,
} from './pos.errors';
import { PosRepository } from './pos.repository';
import { PosCartQuoteResponse } from './pos.types';

@Injectable()
export class PosService {
  constructor(
    private readonly pos: PosRepository,
    @Inject(posConfig.KEY)
    private readonly config: ConfigType<typeof posConfig>,
  ) {}

  async quoteCart(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    dto: QuoteCartDto;
  }): Promise<PosCartQuoteResponse> {
    try {
      const context = await this.pos.getContext(input);
      const requested = new Map<string, bigint>();
      for (const line of input.dto.lines) {
        const quantity = this.toQuantityUnits(line.quantity);
        if (quantity <= 0n) {
          throw new BadRequestException({
            code: 'INVALID_CART_QUANTITY',
            message: 'La cantidad debe ser mayor que cero.',
          });
        }
        requested.set(
          line.productId,
          (requested.get(line.productId) ?? 0n) + quantity,
        );
      }
      const products = await this.pos.getProducts(
        input.tenantId,
        input.warehouseId,
        [...requested.keys()],
      );
      const productMap = new Map(
        products.map((product) => [product.id, product]),
      );
      const taxRate =
        this.config.taxRates[context.countryCode] ??
        this.config.taxRates.DEFAULT ??
        '0.0000';
      const taxBasisPoints = this.taxBasisPoints(taxRate);
      let subtotalCents = 0n;
      let taxCents = 0n;
      let totalCents = 0n;
      const lines = [...requested.entries()].map(
        ([productId, quantityUnits]) => {
          const product = productMap.get(productId);
          if (!product)
            throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' });
          if (!product.active) throw new PosProductNotAvailableError(productId);
          if (quantityUnits > this.toQuantityUnits(product.availableQuantity)) {
            throw new PosInsufficientStockError(productId);
          }
          const lineTotal = this.roundDivide(
            this.toMoneyCents(product.price) * quantityUnits,
            1000n,
          );
          const lineTax =
            taxBasisPoints === 0n
              ? 0n
              : this.roundDivide(
                  lineTotal * taxBasisPoints,
                  10_000n + taxBasisPoints,
                );
          const lineSubtotal = lineTotal - lineTax;
          subtotalCents += lineSubtotal;
          taxCents += lineTax;
          totalCents += lineTotal;
          return {
            product: { id: product.id, name: product.name, sku: product.sku },
            quantity: this.fromQuantityUnits(quantityUnits),
            availableQuantity: product.availableQuantity,
            unitPrice: this.fromMoneyCents(this.toMoneyCents(product.price)),
            subtotal: this.fromMoneyCents(lineSubtotal),
            tax: this.fromMoneyCents(lineTax),
            total: this.fromMoneyCents(lineTotal),
          };
        },
      );
      return {
        data: {
          context: {
            branch: context.branch,
            warehouse: context.warehouse,
            cashRegister: context.cashRegister,
          },
          currency: this.currencyFor(context.countryCode),
          taxRate: this.normalizeTaxRate(taxRate),
          lines,
          totals: {
            subtotal: this.fromMoneyCents(subtotalCents),
            tax: this.fromMoneyCents(taxCents),
            total: this.fromMoneyCents(totalCents),
          },
        },
        meta: { apiVersion: '1', recalculatedAt: new Date().toISOString() },
      };
    } catch (error) {
      if (error instanceof PosContextNotFoundError)
        throw new NotFoundException();
      if (error instanceof PosProductNotAvailableError) {
        throw new ConflictException({
          code: 'PRODUCT_NOT_AVAILABLE',
          productId: error.productId,
        });
      }
      if (error instanceof PosInsufficientStockError) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          productId: error.productId,
        });
      }
      throw error;
    }
  }

  private toQuantityUnits(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  }

  private fromQuantityUnits(value: bigint): string {
    return `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`;
  }

  private toMoneyCents(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }

  private fromMoneyCents(value: bigint): string {
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  }

  private roundDivide(numerator: bigint, denominator: bigint): bigint {
    return (numerator + denominator / 2n) / denominator;
  }

  private taxBasisPoints(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  }

  private normalizeTaxRate(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(4, '0')}`;
  }

  private currencyFor(countryCode: string): string {
    if (countryCode === 'MX') return 'MXN';
    if (countryCode === 'CL') return 'CLP';
    return 'USD';
  }
}
