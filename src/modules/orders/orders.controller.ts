import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { OrdersService } from './orders.service';
import { ReviewsService } from './reviews.service';
import { ReturnsService } from './returns.service';
import { CouponsService } from './coupons.service';
import { FavoritesService } from './favorites.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { CreateReviewDto } from './dto/create-review.dto';
import { CreateReturnDto } from './dto/create-return.dto';
import { CreateFavoriteDto } from './dto/create-favorite.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { Role } from '../../common/types/identity-enums';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
} from '../../common/constants/orders.constants';
import { CheckoutIdempotencyReplayedErrorException } from './checkout-idempotency.service';

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
  constructor(
    private readonly ordersService: OrdersService,
    private readonly reviewsService: ReviewsService,
    private readonly returnsService: ReturnsService,
    private readonly couponsService: CouponsService,
    private readonly favoritesService: FavoritesService,
  ) {}

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
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'F2.1 -- one key per purchase attempt (UUID recommended; 16-128 chars of [A-Za-z0-9._:-]). Reusing it with the same payload returns the order already created (201 + Idempotent-Replayed: true) or the same stored error (also with Idempotent-Replayed: true), never a second order. Omitted: legacy behavior, no protection against retries. See docs/checkout-idempotency.md.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'Also: a checkout with the same Idempotency-Key is still in progress -- retry the same request shortly.',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'Idempotency-Key already used with a different payload -- generate a new key for a new purchase.',
  })
  async checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCheckoutDto,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    try {
      const { order, replayed } =
        await this.ordersService.checkoutWithOptionalKey(
          user.id,
          dto,
          idempotencyKey,
        );
      if (replayed) {
        response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
      }
      return order;
    } catch (error) {
      // Erro repetido de uma chave FAILED: mesmo status/corpo, marcado como
      // repetição (o filtro global de exceções escreve nesta mesma resposta).
      if (error instanceof CheckoutIdempotencyReplayedErrorException) {
        response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
      }
      throw error;
    }
  }

  @Get()
  @ApiOperation({ summary: "Lists the authenticated customer's own orders, newest first." })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.ordersService.listForCustomer(user.id, query);
  }

  // Registrado ANTES de '@Get(":id")' abaixo -- Nest casa rotas na
  // ordem de registro (mesmo raciocínio já documentado em
  // proxy-routes.ts pro api-gateway); se ficasse depois, uma chamada a
  // GET /orders/returns cairia em getOne com id="returns", e
  // ParseUUIDPipe rejeitaria com 400 em vez de listar as devoluções.
  @Get('returns')
  @ApiOperation({
    summary: "Lists the authenticated customer's own return requests, newest first.",
  })
  async listReturns(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.returnsService.listForCustomer(user.id, query);
  }

  // Mesmo raciocínio do comentário acima em 'returns': registrado ANTES de
  // '@Get(":id")' pra não cair em getOne com id="reviews"/"coupons".
  @Get('reviews')
  @ApiOperation({
    summary:
      "Lists the authenticated customer's own reviews (all stores), newest first.",
  })
  async listReviews(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.reviewsService.listForCustomer(user.id, query);
  }

  @Get('coupons')
  @ApiOperation({
    summary: 'Lists currently active, marketplace-wide coupons.',
  })
  async listCoupons() {
    return this.couponsService.listActive();
  }

  // Mesmo raciocínio de 'returns'/'reviews'/'coupons' acima: registrado
  // ANTES de '@Get(":id")' pra não cair em getOne com id="favorites".
  @Get('favorites')
  @ApiOperation({
    summary: "Lists the authenticated customer's own favorited products, newest first.",
  })
  async listFavorites(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.favoritesService.listForCustomer(user.id, query);
  }

  @Post('favorites')
  @ApiOperation({ summary: 'Favorites a product for the authenticated customer (idempotent).' })
  async addFavorite(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateFavoriteDto,
  ) {
    return this.favoritesService.add(user.id, dto.productId);
  }

  @Delete('favorites/:productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unfavorites a product for the authenticated customer (idempotent).' })
  async removeFavorite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ) {
    return this.favoritesService.remove(user.id, productId);
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

  @Post(':orderId/items/:itemId/review')
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOperation({
    summary:
      "Reviews one of the authenticated customer's own order items — one review per item, only once the order has been delivered.",
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Review created.' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      "Order item does not exist, or does not belong to the caller's order (never distinguished from the caller's perspective).",
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Seller order is not yet DELIVERED, or this item was already reviewed.',
  })
  async createReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviewsService.createReview(user.id, orderId, itemId, dto);
  }

  @Post(':orderId/items/:itemId/return')
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOperation({
    summary:
      "Requests a return for one of the authenticated customer's own order items — one request per item, only once the order has been delivered.",
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Return request created.' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      "Order item does not exist, or does not belong to the caller's order (never distinguished from the caller's perspective).",
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Seller order is not yet DELIVERED, or a return was already requested for this item.',
  })
  async createReturn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Body() dto: CreateReturnDto,
  ) {
    return this.returnsService.createReturn(user.id, orderId, itemId, dto);
  }
}
