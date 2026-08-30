import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SaveLoyaltyRuleDto } from './dto/save-loyalty-rule.dto';
import { LoyaltyRepository } from './loyalty.repository';
import { LoyaltyInsufficientBalanceError } from './loyalty.types';

@Injectable()
export class LoyaltyService {
  constructor(private readonly repository: LoyaltyRepository) {}

  async currentRule(tenantId: string) {
    return {
      data: await this.repository.currentRule(tenantId),
      meta: { apiVersion: '1' as const },
    };
  }

  async createRuleVersion(
    tenantId: string,
    userId: string,
    dto: SaveLoyaltyRuleDto,
  ) {
    return {
      data: await this.repository.createRuleVersion(tenantId, userId, dto),
      meta: { apiVersion: '1' as const },
    };
  }

  async statement(tenantId: string, customerId: string, userId: string) {
    const result = await this.repository.statement(
      tenantId,
      customerId,
      userId,
    );
    if (!result) throw new NotFoundException();
    return { data: result, meta: { apiVersion: '1' as const } };
  }

  async preview(input: {
    tenantId: string;
    customerId: string;
    userId: string;
    saleTotal: string;
    pointsToRedeem: number;
  }) {
    try {
      return await this.repository.preview(input);
    } catch (error) {
      if (error instanceof LoyaltyInsufficientBalanceError) {
        throw new ConflictException({
          code: 'LOYALTY_INSUFFICIENT_BALANCE',
          available: error.available,
          requested: error.requested,
        });
      }
      const code = error instanceof Error ? error.message : '';
      if (code === 'LOYALTY_CUSTOMER_NOT_AVAILABLE') {
        throw new BadRequestException({ code: 'POS_CUSTOMER_NOT_AVAILABLE' });
      }
      if (code.startsWith('LOYALTY_')) throw new BadRequestException({ code });
      throw error;
    }
  }
}
