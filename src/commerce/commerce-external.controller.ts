import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CommerceAuthGuard } from './commerce-auth.guard';
import type { CommerceRequest } from './commerce-request.types';
import { RequireCommerceScopes } from './commerce-scopes.decorator';
import { CommerceService } from './commerce.service';
import { CommerceCatalogQueryDto } from './dto/commerce-catalog-query.dto';
import { CreateCommerceOrderDto } from './dto/create-commerce-order.dto';

@Controller('external/v1')
@UseGuards(CommerceAuthGuard)
export class CommerceExternalController {
  constructor(private readonly commerce: CommerceService) {}

  @Get('catalog')
  @RequireCommerceScopes('CATALOG_READ')
  catalog(
    @Req() request: CommerceRequest,
    @Query() query: CommerceCatalogQueryDto,
  ) {
    return this.commerce.catalog(
      request.commercePrincipal,
      query.cursor,
      query.limit,
    );
  }

  @Post('orders')
  @RequireCommerceScopes('ORDERS_WRITE')
  createOrder(
    @Req() request: CommerceRequest,
    @Body() dto: CreateCommerceOrderDto,
  ) {
    return this.commerce.createOrder(request.commercePrincipal, dto);
  }

  @Get('orders/:externalOrderId')
  @RequireCommerceScopes('ORDERS_READ')
  getOrder(
    @Req() request: CommerceRequest,
    @Param('externalOrderId') externalOrderId: string,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,99}$/.test(externalOrderId))
      throw new BadRequestException('INVALID_EXTERNAL_ORDER_ID');
    return this.commerce.externalOrder(
      request.commercePrincipal,
      externalOrderId,
    );
  }
}
