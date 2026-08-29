import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { SaveLoyaltyRuleDto } from './dto/save-loyalty-rule.dto';
import {
  LoyaltyInsufficientBalanceError,
  LoyaltyQuoteData,
  LoyaltyRuleChangedError,
  LoyaltyRuleData,
  LoyaltyStatementData,
} from './loyalty.types';

interface RuleRow {
  id: string;
  version: number | string;
  active: number | boolean;
  earn_amount: string;
  earn_points: number | string;
  redeem_points: number | string;
  redeem_amount: string;
  expiration_days: number | string | null;
  created_at: Date | string;
}

interface CreditRow {
  id: string;
  available_points: number | string;
  rule_id: string;
  rule_snapshot: string | Record<string, unknown>;
  expires_at: Date | string | null;
}

@Injectable()
export class LoyaltyRepository {
  constructor(private readonly dataSource: DataSource) {}

  async currentRule(tenantId: string): Promise<LoyaltyRuleData | null> {
    return this.ruleWithManager(this.dataSource.manager, tenantId);
  }

  async createRuleVersion(
    tenantId: string,
    userId: string,
    dto: SaveLoyaltyRuleDto,
  ): Promise<LoyaltyRuleData> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const [tenant] = await manager.query<Array<{ id: string }>>(
        'SELECT id FROM tenants WHERE id = ? LIMIT 1 FOR UPDATE',
        [tenantId],
      );
      if (!tenant) throw new Error('LOYALTY_TENANT_NOT_FOUND');
      const [latest] = await manager.query<Array<{ version: number | string }>>(
        'SELECT version FROM loyalty_rules WHERE tenant_id = ? ORDER BY version DESC LIMIT 1',
        [tenantId],
      );
      const id = randomUUID();
      const version = Number(latest?.version ?? 0) + 1;
      await manager.query(
        `INSERT INTO loyalty_rules
          (id, tenant_id, version, active, earn_amount, earn_points,
           redeem_points, redeem_amount, expiration_days, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tenantId,
          version,
          dto.active,
          this.money(dto.earnAmount),
          dto.earnPoints,
          dto.redeemPoints,
          this.money(dto.redeemAmount),
          dto.expirationDays ?? null,
          userId,
        ],
      );
      return (await this.ruleById(manager, tenantId, id))!;
    });
  }

  async preview(input: {
    tenantId: string;
    customerId: string;
    userId: string;
    saleTotal: string;
    pointsToRedeem: number;
  }): Promise<LoyaltyQuoteData | null> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.lockCustomer(manager, input.tenantId, input.customerId);
      await this.materializeExpirations(
        manager,
        input.tenantId,
        input.customerId,
        input.userId,
      );
      const rule = await this.ruleWithManager(manager, input.tenantId);
      if (!rule?.active) {
        if (input.pointsToRedeem > 0) throw new Error('LOYALTY_NOT_ACTIVE');
        return null;
      }
      const balance = await this.balance(
        manager,
        input.tenantId,
        input.customerId,
      );
      return this.quote(rule, balance, input.saleTotal, input.pointsToRedeem);
    });
  }

  async applySale(
    manager: EntityManager,
    input: {
      tenantId: string;
      customerId: string;
      userId: string;
      saleId: string;
      idempotencyKey: string;
      saleTotal: string;
      loyalty: LoyaltyQuoteData;
    },
  ): Promise<void> {
    await this.lockCustomer(manager, input.tenantId, input.customerId);
    await this.materializeExpirations(
      manager,
      input.tenantId,
      input.customerId,
      input.userId,
    );
    const rule = await this.ruleWithManager(manager, input.tenantId);
    if (!rule?.active || rule.id !== input.loyalty.rule.id) {
      throw new LoyaltyRuleChangedError();
    }
    const balance = await this.balance(
      manager,
      input.tenantId,
      input.customerId,
    );
    const current = this.quote(
      rule,
      balance,
      input.saleTotal,
      input.loyalty.pointsRedeemed,
    );
    if (
      current.redemptionValue !== input.loyalty.redemptionValue ||
      current.pointsEarned !== input.loyalty.pointsEarned
    ) {
      throw new LoyaltyRuleChangedError();
    }
    const snapshot = this.snapshot(rule);
    if (current.pointsRedeemed > 0) {
      await this.insertDebit(manager, {
        tenantId: input.tenantId,
        customerId: input.customerId,
        ruleId: rule.id,
        saleId: input.saleId,
        type: 'REDEEM',
        points: current.pointsRedeemed,
        monetaryValue: current.redemptionValue,
        idempotencyKey: `loyalty:redeem:${input.idempotencyKey}`,
        snapshot,
        userId: input.userId,
      });
    }
    if (current.pointsEarned > 0) {
      await this.insertCredit(manager, {
        tenantId: input.tenantId,
        customerId: input.customerId,
        ruleId: rule.id,
        saleId: input.saleId,
        type: 'EARN',
        points: current.pointsEarned,
        monetaryValue: input.saleTotal,
        idempotencyKey: `loyalty:earn:${input.idempotencyKey}`,
        snapshot,
        expiresAt: rule.expirationDays
          ? new Date(Date.now() + rule.expirationDays * 86_400_000)
          : null,
        userId: input.userId,
      });
    }
  }

  async compensateSale(
    manager: EntityManager,
    input: {
      tenantId: string;
      saleId: string;
      userId: string;
      mode: 'VOID' | 'RETURN';
      saleReturnId?: string;
    },
  ): Promise<void> {
    const [sale] = await manager.query<
      Array<{
        customer_id: string | null;
        total: string;
        loyalty_points_redeemed: number | string;
        loyalty_points_earned: number | string;
      }>
    >(
      `SELECT customer_id, total, loyalty_points_redeemed, loyalty_points_earned
       FROM sales WHERE tenant_id = ? AND id = ? LIMIT 1 FOR UPDATE`,
      [input.tenantId, input.saleId],
    );
    if (!sale?.customer_id) return;
    const redeemed = Number(sale.loyalty_points_redeemed);
    const earned = Number(sale.loyalty_points_earned);
    if (redeemed === 0 && earned === 0) return;
    await this.lockCustomer(manager, input.tenantId, sale.customer_id);
    await this.materializeExpirations(
      manager,
      input.tenantId,
      sale.customer_id,
      input.userId,
    );
    const source = await manager.query<
      Array<{
        rule_id: string;
        entry_type: 'EARN' | 'REDEEM';
        rule_snapshot: string | Record<string, unknown>;
      }>
    >(
      `SELECT rule_id, entry_type, rule_snapshot FROM loyalty_point_entries
       WHERE tenant_id = ? AND sale_id = ? AND entry_type IN ('EARN','REDEEM')`,
      [input.tenantId, input.saleId],
    );
    if (!source[0]) return;
    let targetRedeemed = redeemed;
    let targetEarned = earned;
    if (input.mode === 'RETURN') {
      const [returns] = await manager.query<Array<{ total: string }>>(
        `SELECT COALESCE(SUM(total), 0) AS total FROM sale_returns
         WHERE tenant_id = ? AND sale_id = ?`,
        [input.tenantId, input.saleId],
      );
      const saleCents = this.toMoney(sale.total);
      const returnedCents = this.toMoney(returns?.total ?? '0');
      targetRedeemed = this.prorate(redeemed, returnedCents, saleCents);
      targetEarned = this.prorate(earned, returnedCents, saleCents);
    }
    const prefix = input.mode === 'VOID' ? 'VOID' : 'RETURN';
    const [existing] = await manager.query<
      Array<{ restored: number | string; reversed: number | string }>
    >(
      `SELECT
         COALESCE(SUM(CASE WHEN entry_type = '${prefix}_REDEEM_RESTORE' THEN points_delta ELSE 0 END), 0) AS restored,
         COALESCE(SUM(CASE WHEN entry_type = '${prefix}_EARN_REVERSAL' THEN -points_delta ELSE 0 END), 0) AS reversed
       FROM loyalty_point_entries WHERE tenant_id = ? AND sale_id = ?`,
      [input.tenantId, input.saleId],
    );
    const restore = Math.max(
      0,
      targetRedeemed - Number(existing?.restored ?? 0),
    );
    const reverse = Math.max(0, targetEarned - Number(existing?.reversed ?? 0));
    const key = input.saleReturnId ?? input.saleId;
    const redeemSource =
      source.find(({ entry_type }) => entry_type === 'REDEEM') ?? source[0];
    const earnSource =
      source.find(({ entry_type }) => entry_type === 'EARN') ?? source[0];
    if (restore > 0) {
      await this.insertCredit(manager, {
        tenantId: input.tenantId,
        customerId: sale.customer_id,
        ruleId: redeemSource.rule_id,
        saleId: input.saleId,
        saleReturnId: input.saleReturnId,
        type: `${prefix}_REDEEM_RESTORE`,
        points: restore,
        monetaryValue: '0.00',
        idempotencyKey: `loyalty:${prefix.toLowerCase()}:restore:${key}`,
        snapshot: this.json(redeemSource.rule_snapshot),
        expiresAt: null,
        userId: input.userId,
      });
    }
    if (reverse > 0) {
      await this.insertDebit(manager, {
        tenantId: input.tenantId,
        customerId: sale.customer_id,
        ruleId: earnSource.rule_id,
        saleId: input.saleId,
        saleReturnId: input.saleReturnId,
        type: `${prefix}_EARN_REVERSAL`,
        points: reverse,
        monetaryValue: '0.00',
        idempotencyKey: `loyalty:${prefix.toLowerCase()}:reverse:${key}`,
        snapshot: this.json(earnSource.rule_snapshot),
        userId: input.userId,
      });
    }
  }

  async statement(
    tenantId: string,
    customerId: string,
    userId: string,
  ): Promise<LoyaltyStatementData | null> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const customer = await this.lockCustomer(
        manager,
        tenantId,
        customerId,
        false,
      );
      if (!customer) return null;
      await this.materializeExpirations(manager, tenantId, customerId, userId);
      const [rule, balance, entries] = await Promise.all([
        this.ruleWithManager(manager, tenantId),
        this.balance(manager, tenantId, customerId),
        manager.query<
          Array<{
            id: string;
            entry_type: LoyaltyStatementData['entries'][number]['type'];
            points_delta: number | string;
            monetary_value: string;
            sale_id: string | null;
            receipt_number: string | null;
            sale_return_id: string | null;
            expires_at: Date | string | null;
            created_at: Date | string;
          }>
        >(
          `SELECT entry.id, entry.entry_type, entry.points_delta,
                  entry.monetary_value, entry.sale_id, sale.receipt_number,
                  entry.sale_return_id, entry.expires_at, entry.created_at
           FROM loyalty_point_entries entry
           LEFT JOIN sales sale ON sale.id = entry.sale_id AND sale.tenant_id = entry.tenant_id
           WHERE entry.tenant_id = ? AND entry.customer_id = ?
           ORDER BY entry.created_at DESC, entry.id DESC LIMIT 200`,
          [tenantId, customerId],
        ),
      ]);
      return {
        customer,
        rule,
        balance,
        entries: entries.map((entry) => ({
          id: entry.id,
          type: entry.entry_type,
          points: Number(entry.points_delta),
          monetaryValue: this.money(entry.monetary_value),
          sale:
            entry.sale_id && entry.receipt_number
              ? { id: entry.sale_id, receiptNumber: entry.receipt_number }
              : null,
          saleReturnId: entry.sale_return_id,
          expiresAt: entry.expires_at
            ? new Date(entry.expires_at).toISOString()
            : null,
          createdAt: new Date(entry.created_at).toISOString(),
        })),
      };
    });
  }

  private quote(
    rule: LoyaltyRuleData,
    balance: number,
    saleTotal: string,
    pointsToRedeem: number,
  ): LoyaltyQuoteData {
    if (pointsToRedeem > balance)
      throw new LoyaltyInsufficientBalanceError(balance, pointsToRedeem);
    if (pointsToRedeem % rule.redeemPoints !== 0)
      throw new Error('LOYALTY_INVALID_REDEMPTION_INCREMENT');
    const redemptionCents =
      (BigInt(pointsToRedeem) / BigInt(rule.redeemPoints)) *
      this.toMoney(rule.redeemAmount);
    const totalCents = this.toMoney(saleTotal);
    if (redemptionCents >= totalCents && redemptionCents > 0n)
      throw new Error('LOYALTY_REDEMPTION_MUST_LEAVE_PAYABLE_BALANCE');
    const payable = totalCents - redemptionCents;
    const earned = Number(
      (payable / this.toMoney(rule.earnAmount)) * BigInt(rule.earnPoints),
    );
    return {
      rule,
      balanceBefore: balance,
      pointsRedeemed: pointsToRedeem,
      redemptionValue: this.fromMoney(redemptionCents),
      pointsEarned: earned,
      balanceAfter: balance - pointsToRedeem + earned,
    };
  }

  private async materializeExpirations(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
    userId: string,
  ): Promise<void> {
    const credits = await manager.query<CreditRow[]>(
      `SELECT entry.id, entry.rule_id, entry.rule_snapshot, entry.expires_at,
              entry.points_delta - COALESCE((SELECT SUM(allocation.points)
                FROM loyalty_point_allocations allocation
                WHERE allocation.tenant_id = entry.tenant_id
                  AND allocation.credit_entry_id = entry.id), 0) AS available_points
       FROM loyalty_point_entries entry
       WHERE entry.tenant_id = ? AND entry.customer_id = ?
         AND entry.points_delta > 0 AND entry.expires_at IS NOT NULL
         AND entry.expires_at <= CURRENT_TIMESTAMP(6)
       ORDER BY entry.expires_at, entry.id`,
      [tenantId, customerId],
    );
    for (const credit of credits) {
      const points = Number(credit.available_points);
      if (points <= 0) continue;
      await this.insertDebit(manager, {
        tenantId,
        customerId,
        ruleId: credit.rule_id,
        type: 'EXPIRE',
        points,
        monetaryValue: '0.00',
        idempotencyKey: `loyalty:expire:${credit.id}`,
        snapshot: this.json(credit.rule_snapshot),
        userId,
        creditId: credit.id,
      });
    }
  }

  private async insertDebit(
    manager: EntityManager,
    input: {
      tenantId: string;
      customerId: string;
      ruleId: string;
      saleId?: string;
      saleReturnId?: string;
      type: 'REDEEM' | 'EXPIRE' | 'VOID_EARN_REVERSAL' | 'RETURN_EARN_REVERSAL';
      points: number;
      monetaryValue: string;
      idempotencyKey: string;
      snapshot: Record<string, unknown>;
      userId: string;
      creditId?: string;
    },
  ): Promise<void> {
    if (input.points <= 0) return;
    const credits = input.creditId
      ? await manager.query<CreditRow[]>(
          `SELECT entry.id, entry.rule_id, entry.rule_snapshot, entry.expires_at,
                  entry.points_delta - COALESCE((SELECT SUM(allocation.points)
                    FROM loyalty_point_allocations allocation
                    WHERE allocation.tenant_id = entry.tenant_id
                      AND allocation.credit_entry_id = entry.id), 0) AS available_points
           FROM loyalty_point_entries entry WHERE entry.id = ? AND entry.tenant_id = ?`,
          [input.creditId, input.tenantId],
        )
      : await this.availableCredits(manager, input.tenantId, input.customerId);
    const available = credits.reduce(
      (sum, credit) => sum + Math.max(0, Number(credit.available_points)),
      0,
    );
    if (available < input.points)
      throw new LoyaltyInsufficientBalanceError(available, input.points);
    const debitId = randomUUID();
    await manager.query(
      `INSERT INTO loyalty_point_entries
        (id, tenant_id, customer_id, rule_id, sale_id, sale_return_id,
         entry_type, points_delta, monetary_value, idempotency_key,
         rule_snapshot, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        debitId,
        input.tenantId,
        input.customerId,
        input.ruleId,
        input.saleId ?? null,
        input.saleReturnId ?? null,
        input.type,
        -input.points,
        input.monetaryValue,
        input.idempotencyKey,
        JSON.stringify(input.snapshot),
        input.userId,
      ],
    );
    let remaining = input.points;
    for (const credit of credits) {
      if (remaining === 0) break;
      const allocated = Math.min(remaining, Number(credit.available_points));
      if (allocated <= 0) continue;
      await manager.query(
        `INSERT INTO loyalty_point_allocations
          (id, tenant_id, debit_entry_id, credit_entry_id, points)
         VALUES (?, ?, ?, ?, ?)`,
        [randomUUID(), input.tenantId, debitId, credit.id, allocated],
      );
      remaining -= allocated;
    }
  }

  private async insertCredit(
    manager: EntityManager,
    input: {
      tenantId: string;
      customerId: string;
      ruleId: string;
      saleId?: string;
      saleReturnId?: string;
      type: 'EARN' | 'VOID_REDEEM_RESTORE' | 'RETURN_REDEEM_RESTORE';
      points: number;
      monetaryValue: string;
      idempotencyKey: string;
      snapshot: Record<string, unknown>;
      expiresAt: Date | null;
      userId: string;
    },
  ): Promise<void> {
    if (input.points <= 0) return;
    await manager.query(
      `INSERT INTO loyalty_point_entries
        (id, tenant_id, customer_id, rule_id, sale_id, sale_return_id,
         entry_type, points_delta, monetary_value, idempotency_key,
         rule_snapshot, expires_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.tenantId,
        input.customerId,
        input.ruleId,
        input.saleId ?? null,
        input.saleReturnId ?? null,
        input.type,
        input.points,
        input.monetaryValue,
        input.idempotencyKey,
        JSON.stringify(input.snapshot),
        input.expiresAt,
        input.userId,
      ],
    );
  }

  private async availableCredits(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
  ): Promise<CreditRow[]> {
    return manager.query<CreditRow[]>(
      `SELECT entry.id, entry.rule_id, entry.rule_snapshot, entry.expires_at,
              entry.points_delta - COALESCE((SELECT SUM(allocation.points)
                FROM loyalty_point_allocations allocation
                WHERE allocation.tenant_id = entry.tenant_id
                  AND allocation.credit_entry_id = entry.id), 0) AS available_points
       FROM loyalty_point_entries entry
       WHERE entry.tenant_id = ? AND entry.customer_id = ?
         AND entry.points_delta > 0
         AND (entry.expires_at IS NULL OR entry.expires_at > CURRENT_TIMESTAMP(6))
       HAVING available_points > 0
       ORDER BY entry.expires_at IS NULL, entry.expires_at, entry.created_at, entry.id`,
      [tenantId, customerId],
    );
  }

  private async balance(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
  ): Promise<number> {
    const [row] = await manager.query<Array<{ balance: number | string }>>(
      `SELECT COALESCE(SUM(points_delta), 0) AS balance
       FROM loyalty_point_entries WHERE tenant_id = ? AND customer_id = ?`,
      [tenantId, customerId],
    );
    return Number(row?.balance ?? 0);
  }

  private async lockCustomer(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
    required = true,
  ): Promise<{ id: string; name: string } | null> {
    const [customer] = await manager.query<Array<{ id: string; name: string }>>(
      `SELECT id, name FROM customers
       WHERE id = ? AND tenant_id = ? AND active = TRUE AND privacy_status = 'ACTIVE'
       LIMIT 1 FOR UPDATE`,
      [customerId, tenantId],
    );
    if (!customer && required)
      throw new Error('LOYALTY_CUSTOMER_NOT_AVAILABLE');
    return customer ?? null;
  }

  private async ruleWithManager(
    manager: EntityManager,
    tenantId: string,
  ): Promise<LoyaltyRuleData | null> {
    const [row] = await manager.query<RuleRow[]>(
      `SELECT id, version, active, earn_amount, earn_points, redeem_points,
              redeem_amount, expiration_days, created_at
       FROM loyalty_rules WHERE tenant_id = ? ORDER BY version DESC LIMIT 1`,
      [tenantId],
    );
    return row ? this.toRule(row) : null;
  }

  private async ruleById(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<LoyaltyRuleData | null> {
    const [row] = await manager.query<RuleRow[]>(
      `SELECT id, version, active, earn_amount, earn_points, redeem_points,
              redeem_amount, expiration_days, created_at
       FROM loyalty_rules WHERE tenant_id = ? AND id = ? LIMIT 1`,
      [tenantId, id],
    );
    return row ? this.toRule(row) : null;
  }

  private toRule(row: RuleRow): LoyaltyRuleData {
    return {
      id: row.id,
      version: Number(row.version),
      active: Boolean(row.active),
      earnAmount: this.money(row.earn_amount),
      earnPoints: Number(row.earn_points),
      redeemPoints: Number(row.redeem_points),
      redeemAmount: this.money(row.redeem_amount),
      expirationDays:
        row.expiration_days === null ? null : Number(row.expiration_days),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private snapshot(rule: LoyaltyRuleData): Record<string, unknown> {
    return {
      id: rule.id,
      version: rule.version,
      earnAmount: rule.earnAmount,
      earnPoints: rule.earnPoints,
      redeemPoints: rule.redeemPoints,
      redeemAmount: rule.redeemAmount,
      expirationDays: rule.expirationDays,
    };
  }

  private prorate(points: number, part: bigint, total: bigint): number {
    if (total <= 0n || part <= 0n) return 0;
    if (part >= total) return points;
    return Number((BigInt(points) * part) / total);
  }

  private toMoney(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  }

  private fromMoney(value: bigint): string {
    return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
  }

  private money(value: string): string {
    return this.fromMoney(this.toMoney(value));
  }

  private json(
    value: string | Record<string, unknown>,
  ): Record<string, unknown> {
    return typeof value === 'string'
      ? (JSON.parse(value) as Record<string, unknown>)
      : value;
  }
}
