import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SellerOrderStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  buildPage,
  PAGINATION_ORDER_CREATED_AT_ID_DESC,
  prismaIdCursorArgs,
  requireCursor,
  resolvePagination,
} from '../../common/pagination/pagination';
import { CreateReviewDto } from './dto/create-review.dto';
import { PublicReviewsQueryDto } from './dto/public-reviews-query.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * Fase B do roadmap pós-entrega (ver roadmap-mercado-livre.md, seção 6):
 * avaliação e reputação. Review vive aqui, não num reviews-service novo —
 * este serviço já é o dono do OrderItem, e "só quem comprou avalia" só é
 * barato de garantir referenciando o item de pedido diretamente, mesmo
 * raciocínio de dono-do-dado já usado no resto do sistema.
 * customerId/sellerId/productId são snapshot no momento da avaliação
 * (nunca FK cross-schema), mesmo padrão de OrderItem.productTitle/sku.
 */
@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Elegibilidade v1: SellerOrder com status CONFIRMED. Ainda não existe
   * conceito de "entregue" no sistema (rastreio é Fase D, não
   * implementada) — ver roadmap-mercado-livre.md, seção 6. Tenant-scoped em
   * SQL, mesmo raciocínio de 404 indistinguível já usado em
   * OrdersService.getForCustomer: um orderItemId que não pertence ao
   * orderId informado, ou a um pedido de outro cliente, não deve ser
   * distinguível de um id inexistente.
   */
  async createReview(
    customerId: string,
    orderId: string,
    orderItemId: string,
    dto: CreateReviewDto,
  ) {
    const orderItem = await this.prisma.orderItem.findFirst({
      where: {
        id: orderItemId,
        sellerOrder: { orderId, order: { customerId } },
      },
      include: { sellerOrder: true, review: true },
    });

    if (!orderItem) {
      throw new NotFoundException('Order item not found');
    }

    if (orderItem.sellerOrder.status !== SellerOrderStatus.CONFIRMED) {
      throw new ConflictException(
        'Review is only allowed once the seller has confirmed this order',
      );
    }

    // O @unique em orderItemId no banco é a rede de segurança real (ver
    // schema.prisma); este check só existe pra devolver 409 com mensagem
    // clara em vez de erro de constraint cru — mesmo padrão documentado no
    // roadmap.
    if (orderItem.review) {
      throw new ConflictException('This order item has already been reviewed');
    }

    try {
      return await this.prisma.review.create({
        data: {
          orderItemId: orderItem.id,
          customerId,
          sellerId: orderItem.sellerOrder.sellerId,
          productId: orderItem.productId,
          rating: dto.rating,
          comment: dto.comment,
        },
      });
    } catch (error) {
      if (this.isReviewConflict(error)) {
        throw new ConflictException('This order item has already been reviewed');
      }
      throw error;
    }
  }

  /**
   * Avaliações recebidas pela loja autenticada, todas — não filtra por
   * productId como listPublic acima. Backs the seller "Avaliações" panel
   * (ver status-migracao-microservicos.md). Mesmo padrão de cursor
   * pagination do resto do serviço; sem @unique/tenant check de cursor
   * cross-seller necessário aqui porque quem chama já vem autenticado como
   * o próprio vendedor (SellerContextGuard, ver seller-reviews.controller.ts) —
   * mesmo raciocínio de SellerOrdersController/listForSeller.
   */
  async listForSeller(sellerId: string, query: PaginationQueryDto = {}) {
    const { limit, cursor } = resolvePagination(query);

    await requireCursor(cursor, async (id) => {
      const review = await this.prisma.review.findFirst({
        where: { id, sellerId },
        select: { id: true },
      });
      return review !== null;
    });

    const rows = await this.prisma.review.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      where: { sellerId },
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });

    return buildPage(rows, limit);
  }

  /**
   * Avaliações enviadas pelo cliente autenticado, todas as lojas juntas —
   * mesmo raciocínio de listForSeller acima, só que filtrando por
   * customerId em vez de sellerId. Backs the customer "Avaliações" panel
   * (`/minha-conta/avaliacoes`, ver status-migracao-microservicos.md).
   * Somente leitura: não existe endpoint de edição de Review (só criação,
   * via createReview acima) — decisão de escopo confirmada com o Arthur,
   * a tela real não repete a função "editar avaliação publicada" que o
   * mock antigo tinha.
   */
  async listForCustomer(customerId: string, query: PaginationQueryDto = {}) {
    const { limit, cursor } = resolvePagination(query);

    await requireCursor(cursor, async (id) => {
      const review = await this.prisma.review.findFirst({
        where: { id, customerId },
        select: { id: true },
      });
      return review !== null;
    });

    const rows = await this.prisma.review.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      where: { customerId },
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });

    return buildPage(rows, limit);
  }

  async listPublic(query: PublicReviewsQueryDto) {
    const { limit, cursor } = resolvePagination(query);

    await requireCursor(cursor, async (id) => {
      const review = await this.prisma.review.findFirst({
        where: { id, productId: query.productId },
        select: { id: true },
      });
      return review !== null;
    });

    const rows = await this.prisma.review.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      where: { productId: query.productId },
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });

    return buildPage(rows, limit);
  }

  async getProductRatingSummary(productId: string) {
    return this.aggregateRating({ productId });
  }

  async getSellerRatingSummary(sellerId: string) {
    return this.aggregateRating({ sellerId });
  }

  private async aggregateRating(where: Prisma.ReviewWhereInput) {
    const result = await this.prisma.review.aggregate({
      where,
      _avg: { rating: true },
      _count: { rating: true },
    });

    return {
      average: result._avg.rating ?? 0,
      count: result._count.rating,
    };
  }

  /** P2002 on the orderItemId @unique — a race with the pre-check above, same shape as OrdersService.isOrderNumberConflict. */
  private isReviewConflict(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return false;
    }
    const rawTarget = error.meta?.target;
    const target = (
      Array.isArray(rawTarget) ? rawTarget.join(',') : String(rawTarget ?? '')
    ).toLowerCase();
    return target.includes('item_pedido_id') || target.includes('orderitemid');
  }
}
