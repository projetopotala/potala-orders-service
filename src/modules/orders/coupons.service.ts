import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Coupon, CouponDiscountType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  PAGINATION_ORDER_CREATED_AT_ID_DESC,
  buildPage,
  prismaIdCursorArgs,
  requireCursor,
  resolvePagination,
} from '../../common/pagination/pagination';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { MAX_PERCENT_DISCOUNT } from '../../common/constants/orders.constants';

export type CouponRuntimeStatus = 'active' | 'scheduled' | 'expired' | 'disabled';

/**
 * Cupons -- pedido de Arthur (urgente, ver status-migracao-microservicos.md
 * e o comentário no model Coupon em schema.prisma pra por que este model
 * vive neste serviço). Vive junto de OrdersService/ReviewsService no mesmo
 * módulo (orders.module.ts), mesmo raciocínio de "concern pequeno, mesmo
 * schema" já documentado lá.
 */
@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `enabled` é a única coluna -- scheduled/expired/active são derivados
   * aqui, em runtime, a partir de comeca_em/termina_em. Ver comentário no
   * model Coupon (schema.prisma) pra por que isso não é uma coluna própria.
   */
  deriveStatus(coupon: Pick<Coupon, 'enabled' | 'startsAt' | 'endsAt'>): CouponRuntimeStatus {
    if (!coupon.enabled) return 'disabled';
    const now = new Date();
    if (now < coupon.startsAt) return 'scheduled';
    if (now > coupon.endsAt) return 'expired';
    return 'active';
  }

  private serialize(coupon: Coupon) {
    return { ...coupon, status: this.deriveStatus(coupon) };
  }

  async list(query: PaginationQueryDto = {}) {
    const { limit, cursor } = resolvePagination(query);
    await requireCursor(cursor, async (id) => {
      const coupon = await this.prisma.coupon.findUnique({ where: { id }, select: { id: true } });
      return coupon !== null;
    });

    const rows = await this.prisma.coupon.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });

    const page = buildPage(rows, limit);
    return { ...page, items: page.items.map((row) => this.serialize(row)) };
  }

  /**
   * Read-only pro painel da loja (SellerCouponsController) -- só cupons
   * dentro da janela e ligados, sem paginação: lista de promoções ativas
   * costuma ser pequena, e não há ação nenhuma pra loja tomar aqui (ver
   * SellerCouponsView.tsx no mock: "criação avançada permanece no admin").
   */
  async listActive() {
    const now = new Date();
    const rows = await this.prisma.coupon.findMany({
      where: { enabled: true, startsAt: { lte: now }, endsAt: { gte: now } },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    return rows.map((row) => this.serialize(row));
  }

  private validateDiscountPair(discountType: CouponDiscountType, discountValue: number) {
    if (discountType === CouponDiscountType.PERCENT && discountValue > MAX_PERCENT_DISCOUNT) {
      throw new BadRequestException(
        `A percentage discount cannot exceed ${MAX_PERCENT_DISCOUNT}`,
      );
    }
  }

  private validateWindow(startsAt: Date, endsAt: Date) {
    if (!(endsAt > startsAt)) {
      throw new BadRequestException('endsAt must be after startsAt');
    }
  }

  async create(dto: CreateCouponDto) {
    this.validateDiscountPair(dto.discountType, dto.discountValue);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    this.validateWindow(startsAt, endsAt);

    try {
      const coupon = await this.prisma.coupon.create({
        data: {
          code: dto.code,
          name: dto.name,
          discountType: dto.discountType,
          discountValue: dto.discountValue,
          startsAt,
          endsAt,
          enabled: dto.enabled ?? true,
        },
      });
      return this.serialize(coupon);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Coupon code "${dto.code}" already exists`);
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateCouponDto) {
    const existing = await this.prisma.coupon.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Coupon not found');
    }

    const discountType = dto.discountType ?? existing.discountType;
    const discountValue = dto.discountValue ?? existing.discountValue;
    this.validateDiscountPair(discountType, discountValue);

    const startsAt = dto.startsAt ? new Date(dto.startsAt) : existing.startsAt;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : existing.endsAt;
    this.validateWindow(startsAt, endsAt);

    try {
      const coupon = await this.prisma.coupon.update({
        where: { id },
        data: {
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          discountType,
          discountValue,
          startsAt,
          endsAt,
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        },
      });
      return this.serialize(coupon);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Coupon code "${dto.code}" already exists`);
      }
      throw error;
    }
  }

  async setEnabled(id: string, enabled: boolean) {
    const existing = await this.prisma.coupon.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      throw new NotFoundException('Coupon not found');
    }
    const coupon = await this.prisma.coupon.update({ where: { id }, data: { enabled } });
    return this.serialize(coupon);
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.coupon.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Coupon not found');
      }
      throw error;
    }
  }

  /**
   * Chamado por OrdersService.checkout ANTES da transação de criação do
   * pedido (mesmo ponto onde subtotalCents/shippingCents já são
   * calculados) -- ver orders.service.ts. Código é normalizado (trim +
   * uppercase) pro mesmo formato salvo em create/update, então a busca é
   * sempre exata, nunca case-insensitive no banco.
   *
   * discountCents nunca excede subtotalCents (FIXED maior que o carrinho
   * não deixa o total negativo) -- mesmo raciocínio defensivo de todo
   * cálculo de dinheiro neste serviço.
   */
  async resolveForCheckout(
    code: string,
    subtotalCents: number,
  ): Promise<{ couponId: string; discountCents: number }> {
    const normalized = code.trim().toUpperCase();
    const coupon = await this.prisma.coupon.findUnique({ where: { code: normalized } });
    if (!coupon || this.deriveStatus(coupon) !== 'active') {
      throw new BadRequestException('Invalid or inactive coupon code');
    }

    const rawDiscount =
      coupon.discountType === CouponDiscountType.PERCENT
        ? Math.round((subtotalCents * coupon.discountValue) / 100)
        : coupon.discountValue;

    return {
      couponId: coupon.id,
      discountCents: Math.min(rawDiscount, subtotalCents),
    };
  }

  /** Called inside the same Prisma transaction that creates the Order (insertOrder in orders.service.ts) -- an order-number-collision retry rolls the whole transaction back, this increment included. */
  async recordUsage(
    tx: Prisma.TransactionClient,
    couponId: string,
    discountCents: number,
  ): Promise<void> {
    await tx.coupon.update({
      where: { id: couponId },
      data: {
        usageCount: { increment: 1 },
        totalDiscountCents: { increment: discountCents },
      },
    });
  }
}
