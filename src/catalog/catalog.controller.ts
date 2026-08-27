import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CatalogService } from './catalog.service';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsDto } from './dto/list-products.dto';
import { ProductAccessGuard } from './product-access.guard';

@Controller('products')
@UseGuards(SessionGuard, ProductAccessGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('options')
  getOptions(@Req() request: AuthenticatedRequest) {
    return this.catalog.getOptions(request.principal.tenant.id);
  }

  @Get()
  listProducts(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListProductsDto,
  ) {
    return this.catalog.listProducts(request.principal.tenant.id, query);
  }

  @Get(':id')
  getProduct(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.catalog.getProduct(request.principal.tenant.id, id);
  }

  @Post()
  createProduct(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateProductDto,
  ) {
    return this.catalog.createProduct(request.principal.tenant.id, dto);
  }
}
