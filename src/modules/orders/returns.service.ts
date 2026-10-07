import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ReturnStatus, SellerOrderStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  buildPage,
  PAGINATION_ORDER_CREATED_AT_ID_DESC,
  prismaIdCursorArgs,
  requireCursor,
  resolvePagination,
} from '../../common/pagination/pagination';
import { CreateReturnDto } from './dto/create-return.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

type DecidableStatus = Extract<ReturnStatus, 'APPROVED' | 'REJECTED'>;

/**
 * Devoluções -- pedido de Arthur ("vamos seguir em frente"), Fase E do
 * roadmap pós-entrega adiantada (ver comentário no model Return,
 * schema.prisma, pra por que este model vive aqui e por que não reembolsa
 * automaticamente). Mesmo raciocínio de dono-do-dado de ReviewsService:
 * este serviço já é dono do OrderItem.
 */
@Injectable()
export class ReturnsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Elegibilidade v1: SellerOrder com status DELIVERED -- corrigido em
   * 29/09, mesmo achado e mesmo motivo de ReviewsService.createReview
   * (DELIVERED já existe e é alcançável via deliverForSeller; esta
   * checagem continuava presa em CONFIRMED, herdada de quando "entregue"
   * ainda não existia no sistema). Tenant-scoped em SQL, mesmo raciocínio
   * de 404 indistinguível já usado em toda escrita autenticada deste
   * serviço.
   */
  async createReturn(
    customerId: string,
    orderId: string,
    orderItemId: string,
    dto: CreateReturnDto,
  ) {
    const orderItem = await this.prisma.orderItem.findFirst({
      where: {
        id: orderItemId,
        sellerOrder: { orderId, order: { customerId } },
      },
      include: { sellerOrder: true, returnRequest: true },
    });

    if (!orderItem) {
      throw new NotFoundException('Order item not found');
    }

    if (orderItem.sellerOrder.status !== SellerOrderStatus.DELIVERED) {
      throw new ConflictException(
        'Return is only allowed once this order has been delivered',
      );
    }

    // O @unique em orderItemId no banco é a rede de segurança real; este
    // check só existe pra devolver 409 com mensagem clara em vez de erro
    // de constraint cru -- mesmo padrão de ReviewsService.
    if (orderItem.returnRequest) {
      throw new ConflictException(
        'A return has already been requested for this order item',
      );
    }

    try {
      return await this.prisma.return.create({
        data: {
          orderItemId: orderItem.id,
          customerId,
          sellerId: orderItem.sellerOrder.sellerId,
          productId: orderItem.productId,
          reason: dto.reason,
          description: dto.description,
        },
      });
    } catch (error) {
      if (this.isReturnConflict(error)) {
        throw new ConflictException(
          'A return has already been requested for this order item',
        );
      }
      throw error;
    }
  }

  /** "Solicitações" da própria conta -- backs a tela de Devoluções do cliente. */
  async listForCustomer(customerId: string, query: PaginationQueryDto = {}) {
    const { limit, cursor } = resolvePagination(query);

    await requireCursor(cursor, async (id) => {
      const returnRequest = await this.prisma.return.findFirst({
        where: { id, customerId },
        select: { id: true },
      });
      return returnRequest !== null;
    });

    const rows = await this.prisma.return.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      where: { customerId },
      include: {
        orderItem: {
          select: {
            productTitle: true,
            sellerOrder: {
              select: { order: { select: { orderNumber: true } } },
            },
          },
        },
      },
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });

    return buildPage(rows, limit);
  }

  /**
   * Admin, marketplace-wide -- o admin como mediador (ver comentário no
   * model Return). Sem where de tenant: quem chama já passou por
   * @Roles(Role.ADMIN) no controller.
   */
  async listForAdmin(query: PaginationQueryDto = {}) {
    const { limit, cursor } = resolvePagination(query);

    await requireCursor(cursor, async (id) => {
      const returnRequest = await this.prisma.return.findFirst({
        where: { id },
        select: { id: true },
      });
      return returnRequest !== null;
    });

    const rows = await this.prisma.return.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      include: {
        orderItem: {
          select: {
            productTitle: true,
            sku: true,
            sellerOrder: {
              select: { order: { select: { orderNumber: true } } },
            },
          },
        },
      },
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });

    return buildPage(rows, limit);
  }

  /**
   * Só sai de REQUESTED -- uma decisão já tomada não muda de ideia nesta
   * v1 (evita um admin "reabrir" silenciosamente algo já resolvido; se
   * precisar reverter, é decisão de produto pra outra rodada).
   */
  async decide(id: string, status: DecidableStatus) {
    const existing = await this.prisma.return.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Return not found');
    }
    if (existing.status !== ReturnStatus.REQUESTED) {
      throw new ConflictException('This return has already been decided');
    }

    // CAS: menor correção possível pro mesmo achado de race condition
    // (rodada de auditoria) -- o update antigo (where só por id) não
    // reconfirmava REQUESTED no momento da escrita, então uma
    // DisputesService.openFromReturnOrigin concorrente podia mover esta
    // Return pra CONTESTED entre a leitura acima e este update, e este
    // update sobrescreveria CONTESTED de volta pra APPROVED/REJECTED
    // silenciosamente. updateMany com REQUESTED na própria WHERE relê e
    // escreve como uma única operação atômica do banco; count === 0
    // significa que a Return não está mais REQUESTED (decidida ou
    // contestada concorrentemente) -- mesmo 409 que o caso já tratado
    // acima, nenhum outro comportamento deste método foi alterado.
    const result = await this.prisma.return.updateMany({
      where: { id, status: ReturnStatus.REQUESTED },
      data: { status },
    });

    if (result.count === 0) {
      throw new ConflictException('This return has already been decided');
    }

    return this.prisma.return.findUnique({ where: { id } });
  }

  /** P2002 on the orderItemId @unique — a race with the pre-check above, same shape as ReviewsService.isReviewConflict. */
  private isReturnConflict(error: unknown): boolean {
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
