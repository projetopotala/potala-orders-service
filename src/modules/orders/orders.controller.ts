import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { Role } from '../../common/types/identity-enums';

/**
 * Every route here is customer-only (Role.CUSTOMER) — there is no seller or
 * admin view of orders in this controller. Sellers see their own
 * (read-only) SellerOrder rows through SellerOrdersController instead — see
 * seller-orders.controller.ts. SessionAuthGuard and RolesGuard are both
 * registered as APP_GUARD in app.module.ts, so neither guard is repeated
 * here.
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
@Roles(Role.CUSTOMER)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('checkout')
  @ApiOperation({
    summary:
      'Creates an order from a client-supplied cart, reserves stock and charges the (mock) payment gateway synchronously.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Order created — check its status to see if payment was approved.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid cart line (unknown variant, product/variant mismatch, inactive product, amount overflow).',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Insufficient stock for one or more items.',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'catalog-service or the payment gateway is unreachable.',
  })
  async checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCheckoutDto,
  ) {
    return this.ordersService.checkout(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: "Lists the authenticated customer's own orders, newest first." })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.ordersService.listForCustomer(user.id, query);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: "Fetches one of the authenticated customer's own orders, including line items and payment attempts.",
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Order does not exist, or belongs to a different customer (never distinguished from the caller's perspective).",
  })
  async getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.ordersService.getForCustomer(user.id, id);
  }
}
