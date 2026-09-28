import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentSeller } from '../../common/decorators/current-seller.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  SellerActiveGuard,
  SellerContextGuard,
} from '../../common/guards/seller.guard';
import { Role } from '../../common/types/identity-enums';
import { SellerContext } from '../../common/types/authenticated-user';

/**
 * The authenticated seller's own SellerOrder rows, never the parent
 * Order's other sellers' rows. SellerContextGuard/SellerActiveGuard
 * resolve sellerId over the network (via sellers-service), same pattern
 * catalog-service already uses for its own seller/* routes.
 *
 * Fulfillment status is now writable (28/09, scope confirmed with Arthur:
 * "só avançar status", no carrier/tracking fields -- those don't exist in
 * the schema): one explicit forward step at a time, never an arbitrary
 * target status, same pattern as AdminContentsController's moderation
 * transitions in catalog-service.
 */
@ApiTags('seller-orders')
@ApiBearerAuth()
@Controller('seller/orders')
@Roles(Role.SELLER)
@UseGuards(SellerContextGuard, SellerActiveGuard)
export class SellerOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @ApiOperation({
    summary:
      "Lists the authenticated store's own SellerOrder rows, newest first (ACTIVE sellers only).",
  })
  list(
    @CurrentSeller() seller: SellerContext,
    @Query() query: PaginationQueryDto,
  ) {
    return this.ordersService.listForSeller(seller.sellerId, query);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      "Fetches one of the authenticated store's own SellerOrder rows, including line items.",
  })
  @ApiResponse({
    status: 404,
    description:
      'SellerOrder does not exist, or belongs to a different store (never distinguished from the caller\'s perspective).',
  })
  getOne(
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.ordersService.getForSeller(seller.sellerId, id);
  }

  @Patch(':id/confirm')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'PENDING -> CONFIRMED.' })
  @ApiResponse({
    status: 409,
    description: 'The seller order is not PENDING.',
  })
  confirm(
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.ordersService.confirmForSeller(seller.sellerId, id);
  }

  @Patch(':id/prepare')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'CONFIRMED -> PREPARING.' })
  @ApiResponse({
    status: 409,
    description: 'The seller order is not CONFIRMED.',
  })
  prepare(
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.ordersService.prepareForSeller(seller.sellerId, id);
  }

  @Patch(':id/ship')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'PREPARING -> SHIPPED.' })
  @ApiResponse({
    status: 409,
    description: 'The seller order is not PREPARING.',
  })
  ship(
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.ordersService.shipForSeller(seller.sellerId, id);
  }

  @Patch(':id/deliver')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'SHIPPED -> DELIVERED.' })
  @ApiResponse({
    status: 409,
    description: 'The seller order is not SHIPPED.',
  })
  deliver(
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.ordersService.deliverForSeller(seller.sellerId, id);
  }
}
