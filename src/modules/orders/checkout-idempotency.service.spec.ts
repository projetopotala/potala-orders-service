import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CheckoutIdempotencyStatus, Prisma } from '@prisma/client';
import {
  CheckoutIdempotencyInProgressException,
  CheckoutIdempotencyReplayedErrorException,
  CheckoutIdempotencyService,
} from './checkout-idempotency.service';
import { createPrismaMock } from '../../test-utils/prisma.mock';
import {
  CHECKOUT_IDEMPOTENCY_LEASE_MS,
  CHECKOUT_IDEMPOTENCY_MAX_CLAIM_ATTEMPTS,
} from '../../common/constants/orders.constants';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

/**
 * F2.1 -- testes UNITÁRIOS (Prisma mockado) de CheckoutIdempotencyService.
 * Provam a lógica de estados e as condições exatas enviadas ao banco; a
 * atomicidade real dessas condições no Postgres é provada à parte (ver
 * docs/checkout-idempotency.md, seção "Validação").
 */
const CUSTOMER = '00000000-0000-4000-8000-000000000c01';
const KEY = '7b0f3c1e-2d4a-4f6b-9c8d-1e2f3a4b5c6d';
const PRODUCT_A = '00000000-0000-4000-8000-00000000a001';
const VARIANT_A = '00000000-0000-4000-8000-00000000a002';
const PRODUCT_B = '00000000-0000-4000-8000-00000000b001';
const VARIANT_B = '00000000-0000-4000-8000-00000000b002';

function dto(overrides: Partial<CreateCheckoutDto> = {}): CreateCheckoutDto {
  return {
    items: [
      { productId: PRODUCT_A, variantId: VARIANT_A, quantity: 2 },
      { productId: PRODUCT_B, variantId: VARIANT_B, quantity: 1 },
    ],
    shippingAddress: {
      recipient: 'Maria Silva',
      street: 'Rua das Flores',
      number: '123',
      neighborhood: 'Centro',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '01310-000',
    },
    ...overrides,
  } as CreateCheckoutDto;
}

function setUp() {
  const prisma = createPrismaMock();
  const service = new CheckoutIdempotencyService(prisma as never);
  return { prisma, service };
}

function existingRow(overrides: Record<string, unknown> = {}) {
  const { service } = setUp();
  return {
    id: 'row-1',
    customerId: CUSTOMER,
    key: KEY,
    requestHash: service.fingerprint(dto()),
    status: CheckoutIdempotencyStatus.IN_PROGRESS,
    lockToken: 'token-old',
    lockedUntil: new Date(Date.now() + 30_000),
    orderId: null,
    responseStatus: null,
    responseBody: null,
    ...overrides,
  };
}

describe('CheckoutIdempotencyService', () => {
  describe('parseKey', () => {
    it('returns null when the header is absent (legacy checkout)', () => {
      expect(setUp().service.parseKey(undefined)).toBeNull();
    });

    it('accepts a UUID', () => {
      expect(setUp().service.parseKey(KEY)).toBe(KEY);
    });

    it.each([
      ['empty', ''],
      ['too short', 'abc123'],
      ['too long', 'a'.repeat(129)],
      ['spaces', 'has space in the key value'],
      ['duplicated header joined by ", "', `${KEY}, ${KEY}`],
      ['array', [KEY, KEY]],
    ])('rejects %s with 400', (_label, raw) => {
      expect(() => setUp().service.parseKey(raw)).toThrow(BadRequestException);
    });
  });

  describe('fingerprint', () => {
    const { service } = setUp();

    it('is a lowercase SHA-256 hex digest', () => {
      expect(service.fingerprint(dto())).toMatch(/^[0-9a-f]{64}$/);
    });

    it('ignores cart line order and coupon letter case', () => {
      const reversed = dto({
        items: [...dto().items].reverse(),
        couponCode: 'promo10',
      });
      expect(service.fingerprint(reversed)).toBe(
        service.fingerprint(dto({ couponCode: ' PROMO10 ' })),
      );
    });

    it.each([
      [
        'quantity',
        dto({
          items: [{ productId: PRODUCT_A, variantId: VARIANT_A, quantity: 3 }],
        }),
      ],
      [
        'address',
        dto({ shippingAddress: { ...dto().shippingAddress, number: '124' } }),
      ],
      ['coupon', dto({ couponCode: 'OUTRO' })],
      [
        'complement',
        dto({
          shippingAddress: { ...dto().shippingAddress, complement: 'Apto 1' },
        }),
      ],
    ])('changes when the %s changes', (_label, changed) => {
      expect(service.fingerprint(changed)).not.toBe(service.fingerprint(dto()));
    });
  });

  describe('begin', () => {
    it('claims a new key with an atomic INSERT ... ON CONFLICT DO NOTHING', async () => {
      const { prisma, service } = setUp();
      const before = Date.now();

      const claim = await service.begin(CUSTOMER, KEY, dto());

      expect(claim.kind).toBe('execute');
      const call = prisma.checkoutIdempotencyKey.createMany.mock
        .calls[0][0] as {
        data: Array<Record<string, unknown>>;
        skipDuplicates: boolean;
      };
      expect(call.skipDuplicates).toBe(true);
      expect(call.data[0]).toMatchObject({
        customerId: CUSTOMER,
        key: KEY,
        requestHash: service.fingerprint(dto()),
        status: CheckoutIdempotencyStatus.IN_PROGRESS,
      });
      const lockedUntil = (call.data[0].lockedUntil as Date).getTime();
      expect(lockedUntil).toBeGreaterThanOrEqual(
        before + CHECKOUT_IDEMPOTENCY_LEASE_MS,
      );
      expect(prisma.checkoutIdempotencyKey.findUnique).not.toHaveBeenCalled();
    });

    it('rejects the same key with a different payload (422) without touching the record', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.createMany.mockResolvedValue({ count: 0 });
      prisma.checkoutIdempotencyKey.findUnique.mockResolvedValue(
        existingRow({
          requestHash: 'f'.repeat(64),
          status: CheckoutIdempotencyStatus.COMPLETED,
          orderId: 'order-1',
        }),
      );

      await expect(service.begin(CUSTOMER, KEY, dto())).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.checkoutIdempotencyKey.updateMany).not.toHaveBeenCalled();
    });

    it('looks the key up scoped to the authenticated customer', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.createMany.mockResolvedValue({ count: 0 });
      prisma.checkoutIdempotencyKey.findUnique.mockResolvedValue(
        existingRow({
          status: CheckoutIdempotencyStatus.COMPLETED,
          orderId: 'order-1',
        }),
      );

      await service.begin(CUSTOMER, KEY, dto());

      expect(prisma.checkoutIdempotencyKey.findUnique).toHaveBeenCalledWith({
        where: { customerId_key: { customerId: CUSTOMER, key: KEY } },
      });
    });

    it('replays a COMPLETED key', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.createMany.mockResolvedValue({ count: 0 });
      prisma.checkoutIdempotencyKey.findUnique.mockResolvedValue(
        existingRow({
          status: CheckoutIdempotencyStatus.COMPLETED,
          orderId: 'order-1',
        }),
      );

      await expect(service.begin(CUSTOMER, KEY, dto())).resolves.toEqual({
        kind: 'replay',
        orderId: 'order-1',
      });
    });

    it('repeats the stored error of a FAILED key (same status and body)', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.createMany.mockResolvedValue({ count: 0 });
      const body = {
        statusCode: 409,
        message: 'Insufficient stock',
        error: 'Conflict',
      };
      prisma.checkoutIdempotencyKey.findUnique.mockResolvedValue(
        existingRow({
          status: CheckoutIdempotencyStatus.FAILED,
          orderId: 'order-1',
          responseStatus: 409,
          responseBody: body,
        }),
      );

      const error = await service
        .begin(CUSTOMER, KEY, dto())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CheckoutIdempotencyReplayedErrorException);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(409);
      expect((error as HttpException).getResponse()).toEqual(body);
    });

    it('answers 409 while another execution holds a live lease', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.createMany.mockResolvedValue({ count: 0 });
      prisma.checkoutIdempotencyKey.findUnique.mockResolvedValue(existingRow());

      await expect(service.begin(CUSTOMER, KEY, dto())).rejects.toBeInstanceOf(
        CheckoutIdempotencyInProgressException,
      );
      expect(prisma.checkoutIdempotencyKey.updateMany).not.toHaveBeenCalled();
    });

    it('never re-executes an interrupted attempt that already created its order', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.createMany.mockResolvedValue({ count: 0 });
      prisma.checkoutIdempotencyKey.findUnique.mockResolvedValue(
        existingRow({
          orderId: 'order-1',
          lockedUntil: new Date(Date.now() - 1),
        }),
      );

      await expect(service.begin(CUSTOMER, KEY, dto())).resolves.toEqual({
        kind: 'replay',
        orderId: 'order-1',
      });
      expect(prisma.checkoutIdempotencyKey.updateMany).not.toHaveBeenCalled();
    });

    it('resumes an expired attempt without order through a conditional UPDATE on the old token', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.createMany.mockResolvedValue({ count: 0 });
      prisma.checkoutIdempotencyKey.findUnique.mockResolvedValue(
        existingRow({ lockedUntil: new Date(Date.now() - 1) }),
      );

      const claim = await service.begin(CUSTOMER, KEY, dto());

      expect(claim.kind).toBe('execute');
      const update = prisma.checkoutIdempotencyKey.updateMany.mock
        .calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(update.where).toMatchObject({
        id: 'row-1',
        status: CheckoutIdempotencyStatus.IN_PROGRESS,
        orderId: null,
        lockToken: 'token-old',
        lockedUntil: { lte: expect.any(Date) },
      });
      expect(update.data.lockToken).not.toBe('token-old');
      if (claim.kind === 'execute') {
        expect(claim.handle).toEqual({
          recordId: 'row-1',
          lockToken: update.data.lockToken,
          orderId: null,
        });
      }
    });

    it('re-reads after losing a resume race and replays the winner result', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.createMany.mockResolvedValue({ count: 0 });
      prisma.checkoutIdempotencyKey.findUnique
        .mockResolvedValueOnce(
          existingRow({ lockedUntil: new Date(Date.now() - 1) }),
        )
        .mockResolvedValueOnce(
          existingRow({
            status: CheckoutIdempotencyStatus.COMPLETED,
            orderId: 'order-9',
          }),
        );
      prisma.checkoutIdempotencyKey.updateMany.mockResolvedValueOnce({
        count: 0,
      });

      await expect(service.begin(CUSTOMER, KEY, dto())).resolves.toEqual({
        kind: 'replay',
        orderId: 'order-9',
      });
    });

    it('retries the INSERT when the conflicting row was released in between', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.createMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.checkoutIdempotencyKey.findUnique.mockResolvedValueOnce(null);

      await expect(service.begin(CUSTOMER, KEY, dto())).resolves.toMatchObject({
        kind: 'execute',
      });
      expect(prisma.checkoutIdempotencyKey.createMany).toHaveBeenCalledTimes(2);
    });

    it('gives up with 409 after bounded attempts instead of looping', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.createMany.mockResolvedValue({ count: 0 });
      prisma.checkoutIdempotencyKey.findUnique.mockResolvedValue(null);

      await expect(service.begin(CUSTOMER, KEY, dto())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.checkoutIdempotencyKey.createMany).toHaveBeenCalledTimes(
        CHECKOUT_IDEMPOTENCY_MAX_CLAIM_ATTEMPTS,
      );
    });
  });

  describe('attachOrder / complete / fail', () => {
    const handle = () => ({
      recordId: 'row-1',
      lockToken: 'token-1',
      orderId: null as string | null,
    });

    it('attaches the order only while still owning the key', async () => {
      const { prisma, service } = setUp();

      await service.attachOrder(prisma as never, handle(), 'order-1');

      expect(prisma.checkoutIdempotencyKey.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'row-1',
          lockToken: 'token-1',
          status: CheckoutIdempotencyStatus.IN_PROGRESS,
          orderId: null,
        },
        data: { orderId: 'order-1' },
      });
    });

    it('throws 409 when another execution took the key over (rolls the order transaction back)', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.attachOrder(prisma as never, handle(), 'order-1'),
      ).rejects.toBeInstanceOf(CheckoutIdempotencyInProgressException);
    });

    it('marks COMPLETED only an execution that created an order', async () => {
      const { prisma, service } = setUp();

      await service.complete(handle());
      expect(prisma.checkoutIdempotencyKey.updateMany).not.toHaveBeenCalled();

      await service.complete({ ...handle(), orderId: 'order-1' });
      expect(prisma.checkoutIdempotencyKey.updateMany).toHaveBeenCalledWith({
        where: { id: 'row-1', lockToken: 'token-1' },
        data: {
          status: CheckoutIdempotencyStatus.COMPLETED,
          completedAt: expect.any(Date),
        },
      });
    });

    it('releases the key when the failure happened before the order existed', async () => {
      const { prisma, service } = setUp();

      await service.fail(
        handle(),
        new ServiceUnavailableException('catalog down'),
      );

      expect(prisma.checkoutIdempotencyKey.deleteMany).toHaveBeenCalledWith({
        where: { id: 'row-1', lockToken: 'token-1', orderId: null },
      });
      expect(prisma.checkoutIdempotencyKey.updateMany).not.toHaveBeenCalled();
    });

    it('stores status and body of an HTTP error raised after the order existed', async () => {
      const { prisma, service } = setUp();

      await service.fail(
        { ...handle(), orderId: 'order-1' },
        new ServiceUnavailableException(
          'Payment gateway is unavailable. Try again shortly.',
        ),
      );

      expect(prisma.checkoutIdempotencyKey.updateMany).toHaveBeenCalledWith({
        where: { id: 'row-1', lockToken: 'token-1' },
        data: {
          status: CheckoutIdempotencyStatus.FAILED,
          responseStatus: 503,
          responseBody: {
            statusCode: 503,
            message: 'Payment gateway is unavailable. Try again shortly.',
            error: 'Service Unavailable',
          },
          completedAt: expect.any(Date),
        },
      });
    });

    it('P-1: a non-HTTP error after the order existed records NOTHING terminal -- keeps the key IN_PROGRESS on its order and releases the lease now', async () => {
      const { prisma, service } = setUp();
      const before = Date.now();

      await service.fail(
        { ...handle(), orderId: 'order-1' },
        new Error('db password=secret'),
      );

      expect(prisma.checkoutIdempotencyKey.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.checkoutIdempotencyKey.updateMany.mock
        .calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(call.where).toEqual({
        id: 'row-1',
        lockToken: 'token-1',
        status: CheckoutIdempotencyStatus.IN_PROGRESS,
        orderId: 'order-1',
      });
      expect(Object.keys(call.data)).toEqual(['lockedUntil']);
      expect((call.data.lockedUntil as Date).getTime()).toBeGreaterThanOrEqual(
        before,
      );
      expect((call.data.lockedUntil as Date).getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
      expect(JSON.stringify(call)).not.toContain('secret');
      expect(prisma.checkoutIdempotencyKey.deleteMany).not.toHaveBeenCalled();
    });

    it('P-1: a Prisma error after the order existed is also uncertain (never stored as FAILED)', async () => {
      const { prisma, service } = setUp();

      await service.fail(
        { ...handle(), orderId: 'order-1' },
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const data = (
        prisma.checkoutIdempotencyKey.updateMany.mock.calls[0][0] as {
          data: Record<string, unknown>;
        }
      ).data;
      expect(data).not.toHaveProperty('status');
      expect(data).not.toHaveProperty('responseStatus');
    });

    it('P-1: after an uncertain failure, the very next retry replays the existing order (no 409 wait, no re-execution)', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.createMany.mockResolvedValue({ count: 0 });
      prisma.checkoutIdempotencyKey.findUnique.mockResolvedValue(
        existingRow({
          status: CheckoutIdempotencyStatus.IN_PROGRESS,
          orderId: 'order-1',
          lockedUntil: new Date(Date.now() - 1),
        }),
      );

      await expect(service.begin(CUSTOMER, KEY, dto())).resolves.toEqual({
        kind: 'replay',
        orderId: 'order-1',
      });
      expect(prisma.checkoutIdempotencyKey.updateMany).not.toHaveBeenCalled();
    });

    it('never masks the checkout outcome when the bookkeeping write itself fails', async () => {
      const { prisma, service } = setUp();
      prisma.checkoutIdempotencyKey.updateMany.mockRejectedValue(
        new Error('db down'),
      );
      prisma.checkoutIdempotencyKey.deleteMany.mockRejectedValue(
        new Error('db down'),
      );

      await expect(
        service.complete({ ...handle(), orderId: 'order-1' }),
      ).resolves.toBeUndefined();
      await expect(
        service.fail(handle(), new Error('x')),
      ).resolves.toBeUndefined();
      await expect(
        service.fail({ ...handle(), orderId: 'order-1' }, new Error('x')),
      ).resolves.toBeUndefined();
    });
  });
});
