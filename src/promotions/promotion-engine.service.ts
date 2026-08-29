import { Injectable } from '@nestjs/common';
import type { PriceChannel } from '../pricing/price-list.types';
import { PromotionRepository } from './promotion.repository';
import { AppliedPromotion, PromotionData } from './promotion.types';

interface PromotionLine {
  productId: string;
  quantity: string;
  unitPrice: string;
  grossTotal: string;
}

@Injectable()
export class PromotionEngineService {
  constructor(private readonly promotions: PromotionRepository) {}

  async resolve(input: {
    tenantId: string;
    branchId: string;
    customerId?: string;
    channel: PriceChannel;
    at: Date;
    lines: PromotionLine[];
  }): Promise<Map<string, AppliedPromotion[]>> {
    const rules = await this.promotions.applicable({
      ...input,
      productIds: input.lines.map(({ productId }) => productId),
    });
    const lines = new Map(input.lines.map((line) => [line.productId, line]));
    const applied = new Map<string, AppliedPromotion[]>();
    const exclusive = new Set<string>();
    const used = new Set<string>();
    for (const rule of rules) {
      const productIds = rule.products.map(({ product }) => product.id);
      if (productIds.some((id) => !lines.has(id))) continue;
      if (productIds.some((id) => exclusive.has(id))) continue;
      if (!rule.stackable && productIds.some((id) => used.has(id))) continue;
      const allocations =
        rule.type === 'BUNDLE_FIXED'
          ? this.bundleAllocations(rule, lines)
          : this.singleAllocation(rule, lines.get(productIds[0])!);
      if (!allocations.length) continue;
      const snapshot = this.snapshot(rule);
      for (const allocation of allocations) {
        applied.set(allocation.productId, [
          ...(applied.get(allocation.productId) ?? []),
          {
            promotion: {
              id: rule.id,
              name: rule.name,
              type: rule.type,
              priority: rule.priority,
            },
            amount: this.money(allocation.amount),
            explanation: allocation.explanation,
            ruleSnapshot: snapshot,
          },
        ]);
      }
      productIds.forEach((id) => used.add(id));
      if (!rule.stackable) productIds.forEach((id) => exclusive.add(id));
    }
    return applied;
  }

  private singleAllocation(rule: PromotionData, line: PromotionLine) {
    const quantity = this.quantity(line.quantity);
    const unitPrice = this.moneyUnits(line.unitPrice);
    let eligibleQuantity = 0n;
    let percent = 0n;
    let explanation = '';
    if (rule.type === 'BUY_X_GET_Y') {
      const buy = this.quantity(rule.buyQuantity!);
      const reward = this.quantity(rule.rewardQuantity!);
      const cycles = quantity / (buy + reward);
      if (!cycles) return [];
      eligibleQuantity = cycles * reward;
      percent = this.percent(rule.discountPercent!);
      explanation = `${rule.name}: ${this.qty(reward)} sin costo parcial por cada ${this.qty(buy)} comprada(s).`;
    } else if (rule.type === 'SECOND_UNIT_PERCENT') {
      const unit = this.quantity(rule.products[0].quantity);
      const cycles = quantity / (unit * 2n);
      if (!cycles) return [];
      eligibleQuantity = cycles * unit;
      percent = this.percent(rule.discountPercent!);
      explanation = `${rule.name}: ${rule.discountPercent}% en la segunda unidad.`;
    } else if (rule.type === 'QUANTITY_PERCENT') {
      const tier = [...rule.tiers]
        .reverse()
        .find(
          ({ minimumQuantity }) => quantity >= this.quantity(minimumQuantity),
        );
      if (!tier) return [];
      eligibleQuantity = quantity;
      percent = this.percent(tier.discountPercent);
      explanation = `${rule.name}: ${tier.discountPercent}% desde ${tier.minimumQuantity} unidad(es).`;
    } else return [];
    const amount = this.roundDivide(
      unitPrice * eligibleQuantity * percent,
      1000n * 1_000_000n,
    );
    return amount > 0n
      ? [{ productId: line.productId, amount, explanation }]
      : [];
  }

  private bundleAllocations(
    rule: PromotionData,
    lines: Map<string, PromotionLine>,
  ) {
    const bundles = rule.products.reduce<bigint | null>((current, item) => {
      const supported =
        this.quantity(lines.get(item.product.id)!.quantity) /
        this.quantity(item.quantity);
      return current === null || supported < current ? supported : current;
    }, null);
    if (!bundles) return [];
    const contributions = rule.products.map((item) => {
      const line = lines.get(item.product.id)!;
      return {
        productId: item.product.id,
        amount: this.roundDivide(
          this.moneyUnits(line.unitPrice) *
            this.quantity(item.quantity) *
            bundles,
          1000n,
        ),
      };
    });
    const regular = contributions.reduce((sum, item) => sum + item.amount, 0n);
    const promotional = this.moneyUnits(rule.fixedPrice!) * bundles;
    const discount = regular - promotional;
    if (discount <= 0n) return [];
    let assigned = 0n;
    return contributions.map((item, index) => {
      const amount =
        index === contributions.length - 1
          ? discount - assigned
          : this.roundDivide(discount * item.amount, regular);
      assigned += amount;
      return {
        productId: item.productId,
        amount,
        explanation: `${rule.name}: ${bundles} combo(s) a ${rule.fixedPrice}.`,
      };
    });
  }

  private snapshot(rule: PromotionData): Record<string, unknown> {
    return {
      type: rule.type,
      priority: rule.priority,
      stackable: rule.stackable,
      discountPercent: rule.discountPercent,
      fixedPrice: rule.fixedPrice,
      buyQuantity: rule.buyQuantity,
      rewardQuantity: rule.rewardQuantity,
      products: rule.products.map(({ product, quantity }) => ({
        productId: product.id,
        quantity,
      })),
      tiers: rule.tiers,
    };
  }

  private quantity(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  }

  private qty(value: bigint): string {
    const whole = value / 1000n;
    const fraction = (value % 1000n).toString().padStart(3, '0');
    return `${whole}.${fraction}`;
  }

  private percent(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
  }

  private moneyUnits(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }

  private money(value: bigint): string {
    return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
  }

  private roundDivide(numerator: bigint, denominator: bigint): bigint {
    return (numerator + denominator / 2n) / denominator;
  }
}
