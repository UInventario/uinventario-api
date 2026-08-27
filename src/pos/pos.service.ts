import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { posConfig } from '../config/pos.config';
import { CreateCashSaleDto } from './dto/create-cash-sale.dto';
import { QuoteCartDto } from './dto/quote-cart.dto';
import {
  PosContextNotFoundError,
  PosIdempotencyConflictError,
  PosInsufficientStockError,
  PosProductNotAvailableError,
} from './pos.errors';
import { PosRepository } from './pos.repository';
import { SalesRepository } from './sales.repository';
import { CashSaleResponse, PosCartQuoteResponse } from './pos.types';

@Injectable()
export class PosService {
  constructor(
    private readonly pos: PosRepository,
    private readonly sales: SalesRepository,
    @Inject(posConfig.KEY)
    private readonly config: ConfigType<typeof posConfig>,
  ) {}

  async createCashSale(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    userId: string;
    idempotencyKey: string | undefined;
    dto: CreateCashSaleDto;
  }): Promise<CashSaleResponse> {
    this.assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = this.saleFingerprint(input.dto);
    try {
      const replay = await this.sales.findByIdempotency(
        input.tenantId,
        input.idempotencyKey!,
      );
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new PosIdempotencyConflictError();
        return {
          data: replay.sale,
          meta: { apiVersion: '1', idempotentReplay: true },
        };
      }
      const quote = await this.quoteCart({
        tenantId: input.tenantId,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        cashRegisterId: input.cashRegisterId,
        dto: { lines: input.dto.lines },
      });
      const receivedCents = this.toMoneyCents(input.dto.cashReceived);
      const totalCents = this.toMoneyCents(quote.data.totals.total);
      if (receivedCents < totalCents) {
        throw new BadRequestException({
          code: 'INSUFFICIENT_CASH_RECEIVED',
          message: 'El efectivo recibido no cubre el total de la venta.',
        });
      }
      const result = await this.sales.persistCashSale({
        tenantId: input.tenantId,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey!,
        fingerprint,
        quote: quote.data,
        amountReceived: this.fromMoneyCents(receivedCents),
        change: this.fromMoneyCents(receivedCents - totalCents),
      });
      return {
        data: result.sale,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof PosIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      throw error;
    }
  }

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

  private assertIdempotencyKey(value: string | undefined): void {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
    }
  }

  private saleFingerprint(dto: CreateCashSaleDto): string {
    const quantities = new Map<string, bigint>();
    for (const line of dto.lines) {
      quantities.set(
        line.productId,
        (quantities.get(line.productId) ?? 0n) +
          this.toQuantityUnits(line.quantity),
      );
    }
    const canonical = {
      lines: [...quantities.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([productId, quantity]) => ({
          productId,
          quantity: this.fromQuantityUnits(quantity),
        })),
      cashReceived: this.fromMoneyCents(this.toMoneyCents(dto.cashReceived)),
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
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
