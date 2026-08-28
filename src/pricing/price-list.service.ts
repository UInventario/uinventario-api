import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  SavePriceListDto,
  UpdatePriceListDto,
} from './dto/save-price-list.dto';
import { PriceListRepository } from './price-list.repository';

@Injectable()
export class PriceListService {
  constructor(private readonly repository: PriceListRepository) {}

  async list(tenantId: string) {
    return {
      data: await this.repository.list(tenantId),
      meta: { apiVersion: '1' as const },
    };
  }

  async create(tenantId: string, dto: SavePriceListDto) {
    try {
      return {
        data: await this.repository.create(tenantId, dto),
        meta: { apiVersion: '1' as const },
      };
    } catch (error) {
      this.translate(error);
    }
  }

  async update(tenantId: string, id: string, dto: UpdatePriceListDto) {
    try {
      const result = await this.repository.update(tenantId, id, dto);
      if (!result) throw new NotFoundException();
      if (result === 'CONFLICT')
        throw new ConflictException({ code: 'PRICE_LIST_VERSION_CONFLICT' });
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
    if (code.startsWith('PRICE_LIST_')) throw new BadRequestException({ code });
    throw error;
  }
}
