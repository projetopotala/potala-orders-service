import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  PAGINATION_ORDER_CREATED_AT_ID_DESC,
  buildPage,
  prismaIdCursorArgs,
  requireCursor,
  resolvePagination,
} from '../../common/pagination/pagination';

/**
 * Lista de desejos do cliente -- ver comentário no model Favorite
 * (schema.prisma) pra por que este domínio vive em orders-service em vez
 * de identity-service. Mesmo padrão de cursor pagination de
 * ReviewsService.listForCustomer/CouponsService.list.
 *
 * Sem snapshot de produto aqui de propósito (só productId) -- o frontend
 * resolve nome/imagem/preço atuais via GET /public/products/:id
 * (catalog-service), um por item da lista. `ProductCard` (usado em toda a
 * vitrine) só precisa saber "é favorito ou não" pra um productId que já
 * tem em mãos -- não precisa dessa resolução, só a tela dedicada
 * /minha-conta/favoritos precisa.
 */
@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForCustomer(customerId: string, query: PaginationQueryDto = {}) {
    const { limit, cursor } = resolvePagination(query);
    await requireCursor(cursor, async (id) => {
      const favorite = await this.prisma.favorite.findFirst({
        where: { id, customerId },
        select: { id: true },
      });
      return favorite !== null;
    });
    const rows = await this.prisma.favorite.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      where: { customerId },
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });
    return buildPage(rows, limit);
  }

  /**
   * Idempotente: favoritar um produto já favoritado não é erro, só
   * devolve o registro existente -- o botão de coração em ProductCard
   * pode ser clicado em rajada (double-click, dois toggles quase
   * simultâneos em telas diferentes) sem precisar tratar 409 no
   * frontend.
   */
  async add(customerId: string, productId: string) {
    try {
      return await this.prisma.favorite.create({
        data: { customerId, productId },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.favorite.findUniqueOrThrow({
          where: { customerId_productId: { customerId, productId } },
        });
      }
      throw error;
    }
  }

  /** Também idempotente -- remover um favorito que já não existe (mesma rajada de cliques acima) não é erro. */
  async remove(customerId: string, productId: string): Promise<void> {
    await this.prisma.favorite.deleteMany({ where: { customerId, productId } });
  }
}
