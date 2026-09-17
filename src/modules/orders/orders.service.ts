import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  OrderStatus,
  Prisma,
  SellerOrderStatus,
  PaymentTransactionStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CatalogServiceClient, InventoryItemInput } from '../../clients/catalog-service.client';
import {
  PAYMENT_GATEWAY_CLIENT,
  PaymentChargeResult,
  PaymentGatewayClient,
} from '../payments/payment-gateway.interface';
import { ProductStatus, ResolvedProductVariant } from '../../common/types/catalog-types';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  buildPage,
  PAGINATION_ORDER_CREATED_AT_ID_DESC,
  prismaIdCursorArgs,
  requireCursor,
  resolvePagination,
} from '../../common/pagination/pagination';
import {
  INT4_MAX,
  MAX_ORDER_NUMBER_RETRIES,
} from '../../common/constants/orders.constants';
import { CreateCheckoutDto, ShippingAddressDto } from './dto/create-checkout.dto';

type ValidatedItem = {
  productId: string;
  variantId: string;
  quantity: number;
  sellerId: string;
  productTitle: string;
  sku: string;
  unitPriceCents: number;
  lineTotalCents: number;
};

type SellerGroup = {
  sellerId: string;
  items: ValidatedItem[];
  subtotalCents: number;
};

/**
 * The only genuinely new business logic in this migration (see README.md):
 * the monolith's own OrdersService was a foundation-stage skeleton
 * (`listByCustomer` only, no controller, checkout explicitly documented as
 * "not implemented in this foundation stage"). This class implements the
 * checkout flow the monolith's own schema comments already specified:
 * resolve/validate against catalog-service, create the Order locally in a
 * SHORT transaction, reserve stock over the network (never inside that
 * transaction — see the Inventory model comment this project has carried
 * since catalog-service), then charge and commit/release.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogServiceClient: CatalogServiceClient,
    @Inject(PAYMENT_GATEWAY_CLIENT)
    private readonly paymentGateway: PaymentGatewayClient,
  ) {}

  async listForCustomer(customerId: string, query: PaginationQueryDto = {}) {
    const { limit, cursor } = resolvePagination(query);

    // Scoped in SQL, not by comparing customerId after a global read: a
    // cursor from another customer must be looked up as if it did not exist.
    await requireCursor(cursor, async (id) => {
      const order = await this.prisma.order.findFirst({
        where: { id, customerId },
        select: { id: true },
      });
      return order !== null;
    });

    const rows = await this.prisma.order.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      where: { customerId },
      include: { sellerOrders: true },
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });

    return buildPage(rows, limit);
  }

  /**
   * Tenant-scoped in SQL on purpose. An order belonging to another customer
   * must be indistinguishable from an order that does not exist, otherwise
   * the 403 itself confirms the id to a foreign tenant — same reasoning as
   * ProductsService.getForSeller in catalog-service.
   */
  async getForCustomer(customerId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      include: {
        shippingAddress: true,
        sellerOrders: { include: { items: true } },
        paymentTransactions: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  async checkout(customerId: string, dto: CreateCheckoutDto) {
    const validatedItems = await this.resolveAndValidateItems(dto.items);
    const sellerGroups = this.groupBySeller(validatedItems);
    const subtotalCents = this.sum(sellerGroups.map((group) => group.subtotalCents));
    // v1 computes neither shipping nor discounts -- both are always 0. See README.md.
    const shippingCents = 0;
    const discountCents = 0;
    const totalCents = this.sum([subtotalCents, shippingCents]) - discountCents;

    const order = await this.createOrderWithRetry(
      customerId,
      dto.shippingAddress,
      { subtotalCents, shippingCents, discountCents, totalCents },
      sellerGroups,
    );

    const inventoryItems: InventoryItemInput[] = validatedItems.map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
    }));

    // Reserve OUTSIDE the transaction that created the order above -- this
    // is a network call, and the project's standing rule (first written for
    // catalog-service's Inventory model, now also in this service's own
    // schema comments) is that a Postgres transaction must never stay open
    // while waiting on a network call to another service.
    try {
      await this.catalogServiceClient.reserveInventory(inventoryItems);
    } catch (error) {
      await this.markOrderCancelled(order.id);
      throw error;
    }

    const paymentTransaction = await this.prisma.paymentTransaction.create({
      data: {
        orderId: order.id,
        status: PaymentTransactionStatus.PENDING,
        amountCents: totalCents,
      },
    });

    let chargeResult: PaymentChargeResult;
    try {
      chargeResult = await this.paymentGateway.charge({
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountCents: totalCents,
      });
    } catch (error) {
      this.logger.error(
        `Payment gateway threw for order ${order.orderNumber}: ${(error as Error).message}`,
      );
      await this.finalizeFailedPayment(order.id, paymentTransaction.id, inventoryItems);
      throw new ServiceUnavailableException(
        'Payment gateway is unavailable. Try again shortly.',
      );
    }

    if (chargeResult.status === 'APPROVED') {
      await this.finalizeApprovedPayment(
        order.id,
        paymentTransaction.id,
        chargeResult,
        inventoryItems,
      );
    } else {
      await this.finalizeFailedPayment(
        order.id,
        paymentTransaction.id,
        inventoryItems,
        chargeResult,
      );
    }

    return this.getForCustomer(customerId, order.id);
  }

  /**
   * Resolves every requested variant against catalog-service in one batched
   * call and validates each cart line against the authoritative result.
   * Nothing about price, seller, product status or stock is ever trusted
   * from the request body itself -- see docs/internal-api-contract.md.
   */
  private async resolveAndValidateItems(
    items: CreateCheckoutDto['items'],
  ): Promise<ValidatedItem[]> {
    const variantIds = [...new Set(items.map((item) => item.variantId))];
    const resolved = await this.catalogServiceClient.resolveVariants(variantIds);
    const byVariantId = new Map<string, ResolvedProductVariant>(
      resolved.map((variant) => [variant.variantId, variant]),
    );

    return items.map((item) => {
      const variant = byVariantId.get(item.variantId);
      if (!variant) {
        throw new BadRequestException(
          `Variant ${item.variantId} does not exist`,
        );
      }
      if (variant.productId !== item.productId) {
        throw new BadRequestException(
          `Variant ${item.variantId} does not belong to product ${item.productId}`,
        );
      }
      if (variant.productStatus !== ProductStatus.ACTIVE) {
        throw new BadRequestException(
          `Product ${variant.productId} is not available for purchase`,
        );
      }
      // Early, non-atomic check for a fast, clear error message. The
      // authoritative, atomic check is catalog-service's own
      // /internal/inventory/reserve, called after the order is created below
      // -- stock can still change between this check and that call, and
      // reserve is what actually protects against overselling.
      if (variant.availableQuantity < item.quantity) {
        throw new ConflictException(
          `Insufficient stock for variant ${item.variantId}`,
        );
      }

      return {
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        sellerId: variant.sellerId,
        productTitle: variant.productTitle,
        sku: variant.sku,
        unitPriceCents: variant.unitPriceCents,
        lineTotalCents: this.multiply(variant.unitPriceCents, item.quantity),
      };
    });
  }

  private groupBySeller(items: ValidatedItem[]): SellerGroup[] {
    const bySeller = new Map<string, ValidatedItem[]>();
    for (const item of items) {
      const existing = bySeller.get(item.sellerId);
      if (existing) {
        existing.push(item);
      } else {
        bySeller.set(item.sellerId, [item]);
      }
    }

    return [...bySeller.entries()].map(([sellerId, sellerItems]) => ({
      sellerId,
      items: sellerItems,
      subtotalCents: this.sum(sellerItems.map((item) => item.lineTotalCents)),
    }));
  }

  private async createOrderWithRetry(
    customerId: string,
    shippingAddress: ShippingAddressDto,
    totals: {
      subtotalCents: number;
      shippingCents: number;
      discountCents: number;
      totalCents: number;
    },
    sellerGroups: SellerGroup[],
  ) {
    for (let attempt = 0; attempt <= MAX_ORDER_NUMBER_RETRIES; attempt += 1) {
      const orderNumber = this.generateOrderNumber();
      try {
        return await this.prisma.$transaction((tx) =>
          this.insertOrder(tx, customerId, orderNumber, shippingAddress, totals, sellerGroups),
        );
      } catch (error) {
        // Anything other than an order-number collision is a real failure —
        // rethrow immediately rather than burning retries on it. A
        // collision falls through to the next loop iteration (or, once the
        // loop itself is exhausted, to the fallback below) instead of being
        // rethrown here: rethrowing on the *last* attempt would leak the
        // raw Prisma error out of this method instead of the clear
        // ConflictException below.
        if (!this.isOrderNumberConflict(error)) {
          throw error;
        }
      }
    }

    throw new ConflictException('Could not allocate a unique order number');
  }

  private async insertOrder(
    tx: Prisma.TransactionClient,
    customerId: string,
    orderNumber: string,
    shippingAddress: ShippingAddressDto,
    totals: {
      subtotalCents: number;
      shippingCents: number;
      discountCents: number;
      totalCents: number;
    },
    sellerGroups: SellerGroup[],
  ) {
    const order = await tx.order.create({
      data: {
        customerId,
        orderNumber,
        status: OrderStatus.PENDING_PAYMENT,
        subtotalCents: totals.subtotalCents,
        shippingCents: totals.shippingCents,
        discountCents: totals.discountCents,
        totalCents: totals.totalCents,
        shippingAddress: {
          create: {
            recipient: shippingAddress.recipient,
            street: shippingAddress.street,
            number: shippingAddress.number,
            complement: shippingAddress.complement,
            neighborhood: shippingAddress.neighborhood,
            city: shippingAddress.city,
            state: shippingAddress.state,
            postalCode: shippingAddress.postalCode,
          },
        },
      },
    });

    for (const group of sellerGroups) {
      const sellerOrder = await tx.sellerOrder.create({
        data: {
          orderId: order.id,
          sellerId: group.sellerId,
          status: SellerOrderStatus.PENDING,
          subtotalCents: group.subtotalCents,
          // v1 computes neither per-seller shipping nor commission. See README.md.
          shippingCents: 0,
          commissionCents: 0,
          sellerNetCents: 0,
        },
      });

      for (const item of group.items) {
        await tx.orderItem.create({
          data: {
            sellerOrderId: sellerOrder.id,
            productId: item.productId,
            variantId: item.variantId,
            productTitle: item.productTitle,
            sku: item.sku,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            lineTotalCents: item.lineTotalCents,
          },
        });
      }
    }

    return order;
  }

  private async markOrderCancelled(orderId: string): Promise<void> {
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
    });
  }

  private async finalizeApprovedPayment(
    orderId: string,
    paymentTransactionId: string,
    chargeResult: PaymentChargeResult,
    inventoryItems: InventoryItemInput[],
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.paymentTransaction.update({
        where: { id: paymentTransactionId },
        data: {
          status: PaymentTransactionStatus.APPROVED,
          provider: chargeResult.provider,
          providerRef: chargeResult.providerRef,
        },
      }),
      this.prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.PAID },
      }),
      this.prisma.sellerOrder.updateMany({
        where: { orderId },
        data: { status: SellerOrderStatus.CONFIRMED },
      }),
    ]);

    try {
      await this.catalogServiceClient.commitInventory(inventoryItems);
    } catch (error) {
      // Known gap, documented in README.md: payment already succeeded and
      // the order is already PAID in this service's own database. A
      // failure here leaves stock reserved-but-not-committed in
      // catalog-service until someone reconciles it by hand -- there is no
      // background retry/reconciliation job in this v1.
      this.logger.error(
        `commitInventory failed for order ${orderId} after an approved payment: ${(error as Error).message}`,
      );
    }
  }

  private async finalizeFailedPayment(
    orderId: string,
    paymentTransactionId: string,
    inventoryItems: InventoryItemInput[],
    chargeResult?: PaymentChargeResult,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.paymentTransaction.update({
        where: { id: paymentTransactionId },
        data: {
          status: PaymentTransactionStatus.FAILED,
          provider: chargeResult?.provider,
          providerRef: chargeResult?.providerRef,
        },
      }),
      this.prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELLED },
      }),
    ]);

    try {
      await this.catalogServiceClient.releaseInventory(inventoryItems);
    } catch (error) {
      // Same known gap as finalizeApprovedPayment's commitInventory, mirrored
      // for the release path: stock could stay reserved-but-not-released.
      this.logger.error(
        `releaseInventory failed for order ${orderId} after a failed payment: ${(error as Error).message}`,
      );
    }
  }

  private generateOrderNumber(): string {
    const timestampPart = Date.now().toString(36).toUpperCase();
    const randomPart = randomBytes(3).toString('hex').toUpperCase();
    return `PED-${timestampPart}-${randomPart}`;
  }

  private isOrderNumberConflict(error: unknown): boolean {
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
    return target.includes('numero_pedido') || target.includes('ordernumber');
  }

  /**
   * Order/SellerOrder/OrderItem money columns are Prisma Int (int4, max
   * 2,147,483,647) -- the same warning catalog-service's own
   * MAX_STOCK_QUANTITY comment left for this service. unitPriceCents can be
   * up to 100,000,000 (catalog-service's MAX_PRICE_CENTS) and quantity up to
   * MAX_ITEM_QUANTITY (1,000): their product alone can exceed int4, so this
   * is checked explicitly rather than trusted to "just fit".
   */
  private multiply(unitPriceCents: number, quantity: number): number {
    const total = unitPriceCents * quantity;
    this.assertFitsInt4(total, 'Order line total');
    return total;
  }

  private sum(values: number[]): number {
    const total = values.reduce((accumulator, value) => accumulator + value, 0);
    this.assertFitsInt4(total, 'Order total');
    return total;
  }

  private assertFitsInt4(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value > INT4_MAX) {
      throw new BadRequestException(
        `${label} exceeds the maximum supported amount`,
      );
    }
  }
}
