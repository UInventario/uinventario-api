import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CatalogService } from './catalog.service';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductAccessGuard } from './product-access.guard';

@Controller('products')
@UseGuards(SessionGuard, ProductAccessGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('options')
  getOptions(@Req() request: AuthenticatedRequest) {
    return this.catalog.getOptions(request.principal.tenant.id);
  }

  @Post()
  createProduct(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateProductDto,
  ) {
    return this.catalog.createProduct(request.principal.tenant.id, dto);
  }
}
