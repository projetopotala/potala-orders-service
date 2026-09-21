import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
 * Read-only on purpose (see status doc): the authenticated seller's own
 * SellerOrder rows, never the parent Order's other sellers' rows. No
 * status-update route here yet — fulfillment writes are a separate,
 * explicitly out-of-scope follow-up. SellerContextGuard/SellerActiveGuard
 * resolve sellerId over the network (via sellers-service), same pattern
 * catalog-service already uses for its own seller/* routes.
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
}
