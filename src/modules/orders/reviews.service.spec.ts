import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReviewsService } from './reviews.service';
import { createPrismaMock } from '../../test-utils/prisma.mock';
import { CreateReviewDto } from './dto/create-review.dto';

const CUSTOMER_ID = '00000000-0000-4000-8000-000000000c01';
const ORDER_ID = '00000000-0000-4000-8000-0000000000d1';
const ORDER_ITEM_ID = '00000000-0000-4000-8000-0000000000e1';
const SELLER_ID = '00000000-0000-4000-8000-00000000a003';
const PRODUCT_ID = '00000000-0000-4000-8000-00000000a001';

function reviewDto(overrides: Partial<CreateReviewDto> = {}): CreateReviewDto {
  return { rating: 5, comment: 'Muito bom', ...overrides } as CreateReviewDto;
}

function orderItemWithSellerOrderStatus(
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: ORDER_ITEM_ID,
    productId: PRODUCT_ID,
    review: null,
    sellerOrder: { id: 'seller-order-1', sellerId: SELLER_ID, status },
    ...overrides,
  };
}

function uniqueOrderItemViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.15.0',
    meta: { target: ['item_pedido_id'] },
  });
}

describe('ReviewsService', () => {
  describe('createReview — eligibility by SellerOrder status', () => {
    // A/B/C/D do pedido: PENDING, CONFIRMED, PREPARING, SHIPPED devem
    // permanecer bloqueados. CANCELLED incluído por completude (existe no
    // enum, nunca deve liberar review).
    const REJECTED_STATUSES = [
      'PENDING',
      'CONFIRMED',
      'PREPARING',
      'SHIPPED',
      'CANCELLED',
    ];

    for (const status of REJECTED_STATUSES) {
      it(`rejects with 409 when SellerOrder is ${status}`, async () => {
        const prisma = createPrismaMock();
        prisma.orderItem.findFirst.mockResolvedValue(
          orderItemWithSellerOrderStatus(status),
        );
        const service = new ReviewsService(prisma as never);

        await expect(
          service.createReview(
            CUSTOMER_ID,
            ORDER_ID,
            ORDER_ITEM_ID,
            reviewDto(),
          ),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.review.create).not.toHaveBeenCalled();
      });
    }

    // E do pedido: só DELIVERED libera.
    it('accepts when SellerOrder is DELIVERED', async () => {
      const prisma = createPrismaMock();
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemWithSellerOrderStatus('DELIVERED'),
      );
      prisma.review.create.mockResolvedValue({ id: 'review-1', rating: 5 });
      const service = new ReviewsService(prisma as never);

      const result = await service.createReview(
        CUSTOMER_ID,
        ORDER_ID,
        ORDER_ITEM_ID,
        reviewDto(),
      );

      expect(prisma.review.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderItemId: ORDER_ITEM_ID,
            customerId: CUSTOMER_ID,
            sellerId: SELLER_ID,
            productId: PRODUCT_ID,
            rating: 5,
          }),
        }),
      );
      expect(result).toEqual({ id: 'review-1', rating: 5 });
    });
  });

  describe('createReview — other existing rules preserved', () => {
    // F do pedido: segunda avaliação do mesmo item continua bloqueada,
    // mesmo já em DELIVERED.
    it('rejects a second review for the same item with 409, even when DELIVERED', async () => {
      const prisma = createPrismaMock();
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemWithSellerOrderStatus('DELIVERED', {
          review: { id: 'existing-review' },
        }),
      );
      const service = new ReviewsService(prisma as never);

      await expect(
        service.createReview(CUSTOMER_ID, ORDER_ID, ORDER_ITEM_ID, reviewDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it('rejects with 409 (race via DB unique constraint) if review.create hits P2002 on item_pedido_id', async () => {
      const prisma = createPrismaMock();
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemWithSellerOrderStatus('DELIVERED'),
      );
      prisma.review.create.mockRejectedValue(uniqueOrderItemViolation());
      const service = new ReviewsService(prisma as never);

      await expect(
        service.createReview(CUSTOMER_ID, ORDER_ID, ORDER_ITEM_ID, reviewDto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // G do pedido: item que não pertence ao cliente/pedido.
    it('404s when the order item does not belong to this customer/order', async () => {
      const prisma = createPrismaMock();
      prisma.orderItem.findFirst.mockResolvedValue(null);
      const service = new ReviewsService(prisma as never);

      await expect(
        service.createReview(CUSTOMER_ID, ORDER_ID, ORDER_ITEM_ID, reviewDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    // H do pedido: item inexistente cai no mesmo 404 indistinguível de G
    // -- comportamento existente e deliberado (mesmo findFirst retornando
    // null), não uma lacuna de cobertura separada.
    it('404s the same way for a non-existent order item id (indistinguishable from G, by design)', async () => {
      const prisma = createPrismaMock();
      prisma.orderItem.findFirst.mockResolvedValue(null);
      const service = new ReviewsService(prisma as never);

      await expect(
        service.createReview(
          CUSTOMER_ID,
          ORDER_ID,
          'non-existent-item-id',
          reviewDto(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('propagates an unrelated error from review.create instead of swallowing it', async () => {
      const prisma = createPrismaMock();
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemWithSellerOrderStatus('DELIVERED'),
      );
      const unrelatedError = new Error('connection reset');
      prisma.review.create.mockRejectedValue(unrelatedError);
      const service = new ReviewsService(prisma as never);

      await expect(
        service.createReview(CUSTOMER_ID, ORDER_ID, ORDER_ITEM_ID, reviewDto()),
      ).rejects.toBe(unrelatedError);
    });
  });
});
