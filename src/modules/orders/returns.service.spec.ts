import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReturnsService } from './returns.service';
import { createPrismaMock } from '../../test-utils/prisma.mock';
import { CreateReturnDto } from './dto/create-return.dto';

const CUSTOMER_ID = '00000000-0000-4000-8000-000000000c01';
const ORDER_ID = '00000000-0000-4000-8000-0000000000d1';
const ORDER_ITEM_ID = '00000000-0000-4000-8000-0000000000e1';
const SELLER_ID = '00000000-0000-4000-8000-00000000a003';
const PRODUCT_ID = '00000000-0000-4000-8000-00000000a001';

function returnDto(overrides: Partial<CreateReturnDto> = {}): CreateReturnDto {
  return { reason: 'Produto com defeito', ...overrides } as CreateReturnDto;
}

function orderItemWithSellerOrderStatus(
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: ORDER_ITEM_ID,
    productId: PRODUCT_ID,
    returnRequest: null,
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

describe('ReturnsService', () => {
  describe('createReturn — eligibility by SellerOrder status (mirrors ReviewsService)', () => {
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
        const service = new ReturnsService(prisma as never);

        await expect(
          service.createReturn(
            CUSTOMER_ID,
            ORDER_ID,
            ORDER_ITEM_ID,
            returnDto(),
          ),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.return.create).not.toHaveBeenCalled();
      });
    }

    it('accepts when SellerOrder is DELIVERED', async () => {
      const prisma = createPrismaMock();
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemWithSellerOrderStatus('DELIVERED'),
      );
      prisma.return.create.mockResolvedValue({
        id: 'return-1',
        reason: 'Produto com defeito',
      });
      const service = new ReturnsService(prisma as never);

      const result = await service.createReturn(
        CUSTOMER_ID,
        ORDER_ID,
        ORDER_ITEM_ID,
        returnDto(),
      );

      expect(prisma.return.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderItemId: ORDER_ITEM_ID,
            customerId: CUSTOMER_ID,
            sellerId: SELLER_ID,
            productId: PRODUCT_ID,
            reason: 'Produto com defeito',
          }),
        }),
      );
      expect(result).toEqual({ id: 'return-1', reason: 'Produto com defeito' });
    });
  });

  describe('decide — CAS contra decisão/contestação concorrente (achado da auditoria de race condition)', () => {
    const RETURN_ID = '00000000-0000-4000-8000-00000000d001';

    it('APPROVED a partir de REQUESTED -> PASS', async () => {
      const prisma = createPrismaMock();
      prisma.return.findUnique.mockResolvedValue({
        id: RETURN_ID,
        status: 'REQUESTED',
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      const service = new ReturnsService(prisma as never);

      await service.decide(RETURN_ID, 'APPROVED' as never);

      // CAS: a WHERE do updateMany reconfirma REQUESTED além do id --
      // mesmo princípio de ClaimsService.transitionStatus/addMessage e
      // DisputesService.openFromClaimOrigin/openFromReturnOrigin.
      expect(prisma.return.updateMany).toHaveBeenCalledWith({
        where: { id: RETURN_ID, status: 'REQUESTED' },
        data: { status: 'APPROVED' },
      });
    });

    it('404s when the return does not exist', async () => {
      const prisma = createPrismaMock();
      prisma.return.findUnique.mockResolvedValue(null);
      const service = new ReturnsService(prisma as never);

      await expect(
        service.decide(RETURN_ID, 'APPROVED' as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it('rejects with 409 when already decided (pre-check de leitura, comportamento preservado)', async () => {
      const prisma = createPrismaMock();
      prisma.return.findUnique.mockResolvedValue({
        id: RETURN_ID,
        status: 'APPROVED',
      });
      const service = new ReturnsService(prisma as never);

      await expect(
        service.decide(RETURN_ID, 'REJECTED' as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    // Race condition (achado da auditoria desta rodada): a Return deixa de
    // estar REQUESTED ENTRE a leitura (findUnique) e o commit do CAS --
    // por exemplo, DisputesService.openFromReturnOrigin movendo-a pra
    // CONTESTED nesse intervalo. Sem o CAS, o update antigo (where só por
    // id) sobrescreveria CONTESTED de volta pra APPROVED/REJECTED
    // silenciosamente.
    it('detecta a Return saindo de REQUESTED entre leitura e commit (CAS count=0) -- não sobrescreve CONTESTED/outra decisão concorrente', async () => {
      const prisma = createPrismaMock();
      prisma.return.findUnique.mockResolvedValue({
        id: RETURN_ID,
        status: 'REQUESTED',
      });
      prisma.return.updateMany.mockResolvedValue({ count: 0 });
      const service = new ReturnsService(prisma as never);

      await expect(
        service.decide(RETURN_ID, 'APPROVED' as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('createReturn — other existing rules preserved', () => {
    it('rejects a second return request for the same item with 409, even when DELIVERED', async () => {
      const prisma = createPrismaMock();
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemWithSellerOrderStatus('DELIVERED', {
          returnRequest: { id: 'existing-return' },
        }),
      );
      const service = new ReturnsService(prisma as never);

      await expect(
        service.createReturn(CUSTOMER_ID, ORDER_ID, ORDER_ITEM_ID, returnDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.return.create).not.toHaveBeenCalled();
    });

    it('rejects with 409 (race via DB unique constraint) if return.create hits P2002 on item_pedido_id', async () => {
      const prisma = createPrismaMock();
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemWithSellerOrderStatus('DELIVERED'),
      );
      prisma.return.create.mockRejectedValue(uniqueOrderItemViolation());
      const service = new ReturnsService(prisma as never);

      await expect(
        service.createReturn(CUSTOMER_ID, ORDER_ID, ORDER_ITEM_ID, returnDto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s when the order item does not belong to this customer/order', async () => {
      const prisma = createPrismaMock();
      prisma.orderItem.findFirst.mockResolvedValue(null);
      const service = new ReturnsService(prisma as never);

      await expect(
        service.createReturn(CUSTOMER_ID, ORDER_ID, ORDER_ITEM_ID, returnDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.return.create).not.toHaveBeenCalled();
    });

    it('propagates an unrelated error from return.create instead of swallowing it', async () => {
      const prisma = createPrismaMock();
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemWithSellerOrderStatus('DELIVERED'),
      );
      const unrelatedError = new Error('connection reset');
      prisma.return.create.mockRejectedValue(unrelatedError);
      const service = new ReturnsService(prisma as never);

      await expect(
        service.createReturn(CUSTOMER_ID, ORDER_ID, ORDER_ITEM_ID, returnDto()),
      ).rejects.toBe(unrelatedError);
    });
  });
});
