import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SavePromotionDto, UpdatePromotionDto } from './dto/save-promotion.dto';
import { PromotionRepository } from './promotion.repository';

@Injectable()
export class PromotionService {
  constructor(private readonly repository: PromotionRepository) {}

  async list(tenantId: string) {
    return {
      data: await this.repository.list(tenantId),
      meta: { apiVersion: '1' as const },
    };
  }

  async create(tenantId: string, dto: SavePromotionDto) {
    try {
      return {
        data: await this.repository.create(tenantId, dto),
        meta: { apiVersion: '1' as const },
      };
    } catch (error) {
      this.translate(error);
    }
  }

  async update(tenantId: string, id: string, dto: UpdatePromotionDto) {
    try {
      const result = await this.repository.update(tenantId, id, dto);
      if (!result) throw new NotFoundException();
      if (result === 'CONFLICT')
        throw new ConflictException({ code: 'PROMOTION_VERSION_CONFLICT' });
      return { data: result, meta: { apiVersion: '1' as const } };
    } catch (error) {
      this.translate(error);
    }
  }

  private translate(error: unknown): never {
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof NotFoundException
    )
      throw error;
    const code = error instanceof Error ? error.message : '';
    if (code.startsWith('PROMOTION_')) throw new BadRequestException({ code });
    throw error;
  }
}
