import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { ReviewsService } from './reviews.service';
import { PublicReviewsQueryDto } from './dto/public-reviews-query.dto';

/**
 * Fase B do roadmap pós-entrega. Anônimo, mesmo raciocínio do @Public() de
 * catalog-service's PublicProductsController: SessionAuthGuard/RolesGuard
 * são globais (APP_GUARD em app.module.ts), então toda rota exige sessão
 * por padrão a menos que opte explicitamente por sair.
 *
 * Rota própria "/public/reviews", não aninhada sob
 * "/public/products"/"/public/sellers" (que pertencem a catalog-service e
 * sellers-service) — evita colidir com os prefixos que api-gateway já
 * proxya inteiros pra esses outros serviços. Os agregados de nota vivem
 * aqui porque Review é dono deste serviço (ver reviews.service.ts) — mais
 * barato que uma chamada cross-service pra um dado que este serviço já tem.
 */
@ApiTags('public-reviews')
@Controller('public/reviews')
@Public()
export class PublicReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get()
  @ApiOperation({ summary: 'Lists reviews for a product, newest first.' })
  list(@Query() query: PublicReviewsQueryDto) {
    return this.reviewsService.listPublic(query);
  }

  @Get('products/:productId/rating-summary')
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOperation({ summary: 'Average rating and review count for a product.' })
  getProductRatingSummary(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ) {
    return this.reviewsService.getProductRatingSummary(productId);
  }

  @Get('sellers/:sellerId/rating-summary')
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiOperation({
    summary: 'Average rating and review count for a seller, across all their products.',
  })
  getSellerRatingSummary(
    @Param('sellerId', new ParseUUIDPipe({ version: '4' })) sellerId: string,
  ) {
    return this.reviewsService.getSellerRatingSummary(sellerId);
  }
}
