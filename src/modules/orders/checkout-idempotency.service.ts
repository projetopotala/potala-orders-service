import { createHash, randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CheckoutIdempotencyStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  CHECKOUT_IDEMPOTENCY_KEY_PATTERN,
  CHECKOUT_IDEMPOTENCY_LEASE_MS,
  CHECKOUT_IDEMPOTENCY_MAX_CLAIM_ATTEMPTS,
} from '../../common/constants/orders.constants';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

/**
 * Posse de uma chave por UMA execução de checkout. `lockToken` identifica a
 * execução dona da linha; toda escrita posterior é condicionada a ele, então
 * uma execução cuja posse venceu e foi retomada por outra não consegue mais
 * vincular pedido nem concluir a chave.
 */
export interface CheckoutIdempotencyHandle {
  readonly recordId: string;
  readonly lockToken: string;
  /** Preenchido quando a transação que criou o pedido foi confirmada. */
  orderId: string | null;
}

export type CheckoutIdempotencyClaim =
  | { kind: 'execute'; handle: CheckoutIdempotencyHandle }
  | { kind: 'replay'; orderId: string };

/** Outra execução com a mesma chave está em andamento (ou acabou de retomá-la). */
export class CheckoutIdempotencyInProgressException extends ConflictException {
  constructor() {
    super(
      'A checkout with this Idempotency-Key is already in progress. Retry the same request shortly.',
    );
  }
}

/**
 * Repetição da resposta de erro gravada numa chave FAILED (mesmo status e
 * corpo da primeira tentativa). Tipo próprio só para o controller marcar a
 * resposta com `Idempotent-Replayed: true`: o cliente sabe que este erro é
 * definitivo para esta chave e que uma nova compra precisa de outra chave.
 */
export class CheckoutIdempotencyReplayedErrorException extends HttpException {}

const GENERIC_FAILURE_BODY = {
  statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
  message: 'Internal server error',
};

/**
 * F2.1 -- idempotência de POST /orders/checkout.
 *
 * Garantias (todas apoiadas no Postgres, nunca em memória -- o serviço pode
 * ter várias instâncias):
 * - (cliente, chave) é UNIQUE: duas requisições concorrentes com a mesma
 *   chave disputam um INSERT ... ON CONFLICT DO NOTHING; só uma executa.
 * - O pedido é vinculado à chave DENTRO da mesma transação curta que cria
 *   Order/SellerOrder/OrderItem, condicionado ao lockToken: ou os dois são
 *   gravados, ou nenhum.
 * - Nenhuma transação fica aberta durante chamadas HTTP (catalog-service,
 *   gateway de pagamento): cada passo aqui é um comando curto e isolado.
 * - Chave nunca fica presa: antes do pedido existir, a posse vence em
 *   CHECKOUT_IDEMPOTENCY_LEASE_MS e pode ser retomada; depois que o pedido
 *   existe, a chave sempre resolve para ele.
 */
@Injectable()
export class CheckoutIdempotencyService {
  private readonly logger = new Logger(CheckoutIdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Header ausente -> null (checkout sem idempotência, comportamento
   * anterior). Header presente e fora do padrão -> 400; nunca é aceito
   * parcialmente nem normalizado em silêncio.
   */
  parseKey(raw: unknown): string | null {
    if (raw === undefined) {
      return null;
    }
    if (
      typeof raw !== 'string' ||
      !CHECKOUT_IDEMPOTENCY_KEY_PATTERN.test(raw)
    ) {
      throw new BadRequestException(
        'Invalid Idempotency-Key header: use 16 to 128 characters from [A-Za-z0-9._:-] (a UUID is recommended).',
      );
    }
    return raw;
  }

  /**
   * SHA-256 do payload RELEVANTE em forma canônica (depois do
   * ValidationPipe, que já aparou os textos). A ordem das linhas do
   * carrinho não altera o pedido gerado, então as linhas são ordenadas; o
   * cupom é comparado na mesma normalização de CouponsService
   * (trim + maiúsculas).
   */
  fingerprint(dto: CreateCheckoutDto): string {
    const items = dto.items
      .map(
        (item) =>
          [
            item.productId.toLowerCase(),
            item.variantId.toLowerCase(),
            item.quantity,
          ] as const,
      )
      .sort((left, right) =>
        left[0] !== right[0]
          ? left[0] < right[0]
            ? -1
            : 1
          : left[1] !== right[1]
            ? left[1] < right[1]
              ? -1
              : 1
            : left[2] - right[2],
      );
    const address = dto.shippingAddress;
    const canonical = {
      v: 1,
      items,
      shippingAddress: [
        address.recipient,
        address.street,
        address.number,
        address.complement ?? null,
        address.neighborhood,
        address.city,
        address.state,
        address.postalCode,
      ],
      couponCode: dto.couponCode ? dto.couponCode.trim().toUpperCase() : null,
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  /**
   * Reivindica a chave para executar o checkout, ou devolve o que um retry
   * deve receber. Lança 422 (payload diferente), 409 (execução em
   * andamento) ou o mesmo erro HTTP de uma tentativa FAILED.
   */
  async begin(
    customerId: string,
    key: string,
    dto: CreateCheckoutDto,
  ): Promise<CheckoutIdempotencyClaim> {
    const requestHash = this.fingerprint(dto);

    for (
      let attempt = 0;
      attempt < CHECKOUT_IDEMPOTENCY_MAX_CLAIM_ATTEMPTS;
      attempt += 1
    ) {
      const now = new Date();
      const handle: CheckoutIdempotencyHandle = {
        recordId: randomUUID(),
        lockToken: randomUUID(),
        orderId: null,
      };
      // INSERT ... ON CONFLICT DO NOTHING: atômico no Postgres. count 1 =
      // esta requisição é a dona; count 0 = a chave já existe.
      const inserted = await this.prisma.checkoutIdempotencyKey.createMany({
        data: [
          {
            id: handle.recordId,
            customerId,
            key,
            requestHash,
            status: CheckoutIdempotencyStatus.IN_PROGRESS,
            lockToken: handle.lockToken,
            lockedUntil: this.leaseFrom(now),
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        return { kind: 'execute', handle };
      }

      const existing = await this.prisma.checkoutIdempotencyKey.findUnique({
        where: { customerId_key: { customerId, key } },
      });
      if (!existing) {
        // Liberada (falha antes do pedido) entre o INSERT e a leitura.
        continue;
      }
      if (existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException(
          'This Idempotency-Key was already used with a different checkout payload. Use a new key for a new purchase.',
        );
      }

      if (existing.status === CheckoutIdempotencyStatus.COMPLETED) {
        return {
          kind: 'replay',
          orderId: this.requireOrderId(existing.orderId),
        };
      }
      if (existing.status === CheckoutIdempotencyStatus.FAILED) {
        throw new CheckoutIdempotencyReplayedErrorException(
          (existing.responseBody as Record<string, unknown> | null) ??
            GENERIC_FAILURE_BODY,
          existing.responseStatus ?? HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // IN_PROGRESS
      if (existing.lockedUntil.getTime() > now.getTime()) {
        throw new CheckoutIdempotencyInProgressException();
      }
      if (existing.orderId) {
        // Execução interrompida DEPOIS de o pedido existir: nunca
        // reexecutar (reserva/cobrança poderiam se repetir). O retry recebe
        // o pedido no estado em que ficou.
        return { kind: 'replay', orderId: existing.orderId };
      }
      // Execução interrompida ANTES do pedido existir e posse vencida:
      // retoma com UPDATE condicional -- só um retry concorrente vence.
      const resumed: CheckoutIdempotencyHandle = {
        recordId: existing.id,
        lockToken: randomUUID(),
        orderId: null,
      };
      const reclaimed = await this.prisma.checkoutIdempotencyKey.updateMany({
        where: {
          id: existing.id,
          status: CheckoutIdempotencyStatus.IN_PROGRESS,
          orderId: null,
          lockToken: existing.lockToken,
          lockedUntil: { lte: now },
        },
        data: {
          lockToken: resumed.lockToken,
          lockedUntil: this.leaseFrom(now),
        },
      });
      if (reclaimed.count === 1) {
        return { kind: 'execute', handle: resumed };
      }
      // Outro retry retomou ou concluiu no meio do caminho: relê.
    }
    throw new CheckoutIdempotencyInProgressException();
  }

  /**
   * Vincula o pedido à chave, DENTRO da transação que cria o pedido. Se a
   * posse foi retomada por outra execução (token trocado) ou a chave já tem
   * pedido, lança e a transação inteira (pedido, itens, uso de cupom) é
   * desfeita.
   */
  async attachOrder(
    tx: Prisma.TransactionClient,
    handle: CheckoutIdempotencyHandle,
    orderId: string,
  ): Promise<void> {
    const attached = await tx.checkoutIdempotencyKey.updateMany({
      where: {
        id: handle.recordId,
        lockToken: handle.lockToken,
        status: CheckoutIdempotencyStatus.IN_PROGRESS,
        orderId: null,
      },
      data: { orderId },
    });
    if (attached.count !== 1) {
      throw new CheckoutIdempotencyInProgressException();
    }
  }

  /** Execução terminou com resposta 2xx (pedido PAID, CANCELLED por pagamento recusado, ou PENDING_PAYMENT). */
  async complete(handle: CheckoutIdempotencyHandle): Promise<void> {
    if (!handle.orderId) {
      return;
    }
    await this.bestEffort('complete', () =>
      this.prisma.checkoutIdempotencyKey.updateMany({
        where: { id: handle.recordId, lockToken: handle.lockToken },
        data: {
          status: CheckoutIdempotencyStatus.COMPLETED,
          completedAt: new Date(),
        },
      }),
    );
  }

  /**
   * Execução terminou em erro.
   * - Sem pedido: libera a chave (o mesmo request pode ser repetido e
   *   reexecutado).
   * - Com pedido e erro HTTP: grava o erro (FAILED) para que um retry receba
   *   exatamente a mesma resposta, sem nova reserva ou cobrança. Os erros
   *   HTTP desta fase só são lançados depois de o pedido ter sido levado a
   *   um estado definitivo (CANCELLED por reserva ou pagamento).
   * - Com pedido e erro NÃO HTTP (Prisma, rede, bug): o resultado é incerto
   *   -- o pedido pode até já estar PAID (ex.: falha só na leitura final).
   *   Nada terminal é gravado: a chave continua IN_PROGRESS vinculada ao
   *   pedido e a posse é liberada já, para que o retry receba o pedido no
   *   estado real (begin -> replay), sem reexecutar estoque nem pagamento.
   */
  async fail(handle: CheckoutIdempotencyHandle, error: unknown): Promise<void> {
    if (handle.orderId && !(error instanceof HttpException)) {
      const orderId = handle.orderId;
      await this.bestEffort('release-uncertain', () =>
        this.prisma.checkoutIdempotencyKey.updateMany({
          where: {
            id: handle.recordId,
            lockToken: handle.lockToken,
            status: CheckoutIdempotencyStatus.IN_PROGRESS,
            orderId,
          },
          data: { lockedUntil: new Date() },
        }),
      );
      return;
    }
    if (!handle.orderId) {
      await this.bestEffort('release', () =>
        this.prisma.checkoutIdempotencyKey.deleteMany({
          where: {
            id: handle.recordId,
            lockToken: handle.lockToken,
            orderId: null,
          },
        }),
      );
      return;
    }
    const { status, body } = this.describeError(error);
    await this.bestEffort('fail', () =>
      this.prisma.checkoutIdempotencyKey.updateMany({
        where: { id: handle.recordId, lockToken: handle.lockToken },
        data: {
          status: CheckoutIdempotencyStatus.FAILED,
          responseStatus: status,
          responseBody: body as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      }),
    );
  }

  private describeError(error: unknown): {
    status: number;
    body: Record<string, unknown>;
  } {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      const body =
        typeof response === 'string'
          ? { statusCode: error.getStatus(), message: response }
          : (response as Record<string, unknown>);
      const status = error.getStatus();
      return status >= 400 && status <= 599
        ? { status, body }
        : {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            body: GENERIC_FAILURE_BODY,
          };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: GENERIC_FAILURE_BODY,
    };
  }

  /**
   * Escritas de fechamento não podem mascarar o resultado real do checkout.
   * Se falharem, a linha fica IN_PROGRESS: sem pedido ela é retomável após
   * a posse vencer; com pedido, o retry recebe o pedido existente.
   */
  private async bestEffort(
    label: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.logger.error(
        `Checkout idempotency ${label} bookkeeping failed: ${(error as Error).message}`,
      );
    }
  }

  private leaseFrom(now: Date): Date {
    return new Date(now.getTime() + CHECKOUT_IDEMPOTENCY_LEASE_MS);
  }

  private requireOrderId(orderId: string | null): string {
    if (!orderId) {
      // Impossível pelo CHECK chaves_idempotencia_checkout_estado_check.
      throw new ConflictException('Inconsistent idempotency record');
    }
    return orderId;
  }
}
