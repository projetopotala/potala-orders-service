import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReviewsService } from './reviews.service';
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
 * Read-only, mesmo padrão de SellerOrdersController: avaliações recebidas
 * pela loja autenticada, nunca de outra loja. Novo esta sessão, backs the
 * seller "Avaliações" panel (ver status-migracao-microservicos.md) — antes
 * dessa tela, o único jeito de ler Review era GET /public/reviews
 * (filtrado por productId, sem sessão) ou os dois rating-summary — nenhum
 * dos dois lista as avaliações da loja em si.
 */
@ApiTags('seller-reviews')
@ApiBearerAuth()
@Controller('seller/reviews')
@Roles(Role.SELLER)
@UseGuards(SellerContextGuard, SellerActiveGuard)
export class SellerReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get()
  @ApiOperation({
    summary:
      "Lists the authenticated store's own reviews, newest first (ACTIVE sellers only).",
  })
  list(
    @CurrentSeller() seller: SellerContext,
    @Query() query: PaginationQueryDto,
  ) {
    return this.reviewsService.listForSeller(seller.sellerId, query);
  }
}
