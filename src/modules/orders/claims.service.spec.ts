import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClaimStatus, SellerOrderStatus } from '@prisma/client';
import { ClaimsService } from './claims.service';
import { createPrismaMock, PrismaMock } from '../../test-utils/prisma.mock';
import { Role } from '../../common/types/identity-enums';
import { PostSaleActor } from '../../common/types/post-sale-actor';
import { CreateClaimDto } from './dto/create-claim.dto';
import { AddClaimEvidenceDto } from './dto/add-claim-evidence.dto';

const CUSTOMER_ID = '00000000-0000-4000-8000-000000000c01';
const OTHER_CUSTOMER_ID = '00000000-0000-4000-8000-000000000c02';
const ORDER_ID = '00000000-0000-4000-8000-0000000000d1';
const ORDER_ITEM_ID = '00000000-0000-4000-8000-0000000000e1';
const SELLER_ORDER_ID = '00000000-0000-4000-8000-00000000f001';
const SELLER_ID = '00000000-0000-4000-8000-00000000a003';
const OTHER_SELLER_ID = '00000000-0000-4000-8000-00000000a004';
const CLAIM_ID = '00000000-0000-4000-8000-000000009001';
const ACTOR_USER_ID = '00000000-0000-4000-8000-000000009999';

const CUSTOMER_ACTOR: PostSaleActor = {
  role: Role.CUSTOMER,
  userId: ACTOR_USER_ID,
  customerId: CUSTOMER_ID,
};
const OTHER_CUSTOMER_ACTOR: PostSaleActor = {
  role: Role.CUSTOMER,
  userId: 'other-user',
  customerId: OTHER_CUSTOMER_ID,
};
const SELLER_ACTOR: PostSaleActor = {
  role: Role.SELLER,
  userId: ACTOR_USER_ID,
  sellerId: SELLER_ID,
};
const OTHER_SELLER_ACTOR: PostSaleActor = {
  role: Role.SELLER,
  userId: 'other-seller-user',
  sellerId: OTHER_SELLER_ID,
};
const ADMIN_ACTOR: PostSaleActor = { role: Role.ADMIN, userId: 'admin-user' };

function claimDto(overrides: Partial<CreateClaimDto> = {}): CreateClaimDto {
  return { reason: 'Item nunca chegou', ...overrides } as CreateClaimDto;
}

function evidenceDto(
  overrides: Partial<AddClaimEvidenceDto> = {},
): AddClaimEvidenceDto {
  return {
    storageKey: 'claims/evidence-1',
    fileName: 'foto.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    ...overrides,
  } as AddClaimEvidenceDto;
}

function orderItemWithSellerOrderStatus(status: SellerOrderStatus) {
  return {
    id: ORDER_ITEM_ID,
    productId: 'product-1',
    sellerOrder: { id: SELLER_ORDER_ID, sellerId: SELLER_ID, status },
  };
}

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CLAIM_ID,
    orderId: ORDER_ID,
    sellerOrderId: SELLER_ORDER_ID,
    orderItemId: ORDER_ITEM_ID,
    customerId: CUSTOMER_ID,
    sellerId: SELLER_ID,
    status: ClaimStatus.OPEN,
    resolvedAt: null,
    ...overrides,
  };
}

describe('ClaimsService', () => {
  let prisma: PrismaMock;
  let service: ClaimsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new ClaimsService(prisma as never);
  });

  /**
   * Invariante crítica (pedido original, fundação P0): ClaimsService NUNCA
   * pode chamar order.update/sellerOrder.update/.updateMany, em nenhum
   * método -- pós-venda não controla o ciclo de vida de fulfillment.
   */
  afterEach(() => {
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.sellerOrder.update).not.toHaveBeenCalled();
    expect(prisma.sellerOrder.updateMany).not.toHaveBeenCalled();
  });

  describe('createClaim — elegibilidade por SellerOrderStatus', () => {
    // PENDING bloqueado (pedido desta rodada)
    it('rejects with 409 when the SellerOrder is PENDING', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemWithSellerOrderStatus(SellerOrderStatus.PENDING),
      );

      await expect(
        service.createClaim(CUSTOMER_ID, ORDER_ID, ORDER_ITEM_ID, claimDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.claim.create).not.toHaveBeenCalled();
    });

    // Consequência direta da mesma allow-list -- não pedida explicitamente, sinalizada no relatório
    it('rejects with 409 when the SellerOrder is CANCELLED', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemWithSellerOrderStatus(SellerOrderStatus.CANCELLED),
      );

      await expect(
        service.createClaim(CUSTOMER_ID, ORDER_ID, ORDER_ITEM_ID, claimDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.claim.create).not.toHaveBeenCalled();
    });

    for (const status of [
      SellerOrderStatus.CONFIRMED,
      SellerOrderStatus.PREPARING,
      SellerOrderStatus.SHIPPED,
      SellerOrderStatus.DELIVERED,
    ]) {
      it(`accepts when the SellerOrder is ${status}`, async () => {
        prisma.orderItem.findFirst.mockResolvedValue(
          orderItemWithSellerOrderStatus(status),
        );
        prisma.claim.create.mockResolvedValue(claimRow());

        const result = await service.createClaim(
          CUSTOMER_ID,
          ORDER_ID,
          ORDER_ITEM_ID,
          claimDto(),
        );

        expect(prisma.claim.create).toHaveBeenCalledWith({
          data: {
            orderId: ORDER_ID,
            sellerOrderId: SELLER_ORDER_ID,
            orderItemId: ORDER_ITEM_ID,
            customerId: CUSTOMER_ID,
            sellerId: SELLER_ID,
            reason: 'Item nunca chegou',
            description: undefined,
          },
        });
        expect(result).toEqual(claimRow());
      });
    }

    it('404s when the order item does not belong to this customer/order chain', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(null);

      await expect(
        service.createClaim(CUSTOMER_ID, ORDER_ID, ORDER_ITEM_ID, claimDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.claim.create).not.toHaveBeenCalled();
    });
  });

  describe('ownership — getForCustomer/getForSeller/getForAdmin', () => {
    it('getForCustomer 404s for a claim belonging to a different customer', async () => {
      prisma.claim.findFirst.mockResolvedValue(null);

      await expect(
        service.getForCustomer(OTHER_CUSTOMER_ID, CLAIM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.claim.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CLAIM_ID, customerId: OTHER_CUSTOMER_ID },
        }),
      );
    });

    it('getForSeller 404s for a claim belonging to a different seller', async () => {
      prisma.claim.findFirst.mockResolvedValue(null);

      await expect(
        service.getForSeller(OTHER_SELLER_ID, CLAIM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getForAdmin returns the claim regardless of owner, but requires actor.role === ADMIN', async () => {
      prisma.claim.findFirst.mockResolvedValue(claimRow());

      const result = await service.getForAdmin(ADMIN_ACTOR, CLAIM_ID);

      expect(prisma.claim.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CLAIM_ID } }),
      );
      expect(result).toEqual(claimRow());

      await expect(
        service.getForAdmin(CUSTOMER_ACTOR, CLAIM_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('addMessage — ownership (tenant-scoped, não "buscar por id e filtrar depois")', () => {
    it('customer próprio -> PASS', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claimMessage.create.mockResolvedValue({ id: 'message-1' });

      await service.addMessage(CLAIM_ID, CUSTOMER_ACTOR, 'Olá');

      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, customerId: CUSTOMER_ID },
      });
      expect(prisma.claimMessage.create).toHaveBeenCalledWith({
        data: {
          claimId: CLAIM_ID,
          authorUserId: ACTOR_USER_ID,
          authorRole: 'CUSTOMER',
          body: 'Olá',
        },
      });
    });

    it('customer message é escrita dentro de uma transaction interativa (CAS + mensagem atômicas)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claimMessage.create.mockResolvedValue({ id: 'message-1' });

      await service.addMessage(CLAIM_ID, CUSTOMER_ACTOR, 'Olá');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.claim.updateMany).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, status: ClaimStatus.OPEN },
        data: { status: ClaimStatus.SELLER_RESPONSE_REQUIRED },
      });
    });

    it('customer de terceiro -> 404', async () => {
      prisma.claim.findFirst.mockResolvedValue(null);

      await expect(
        service.addMessage(CLAIM_ID, OTHER_CUSTOMER_ACTOR, 'Olá'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, customerId: OTHER_CUSTOMER_ID },
      });
      expect(prisma.claimMessage.create).not.toHaveBeenCalled();
    });

    it('seller próprio -> PASS', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claimMessage.create.mockResolvedValue({ id: 'message-1' });

      await service.addMessage(CLAIM_ID, SELLER_ACTOR, 'Vamos resolver');

      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, sellerId: SELLER_ID },
      });
    });

    it('seller de outro tenant -> 404', async () => {
      prisma.claim.findFirst.mockResolvedValue(null);

      await expect(
        service.addMessage(CLAIM_ID, OTHER_SELLER_ACTOR, 'Vamos resolver'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, sellerId: OTHER_SELLER_ID },
      });
      expect(prisma.claimMessage.create).not.toHaveBeenCalled();
    });

    it('admin -> PASS (sem escopo de tenant)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claimMessage.create.mockResolvedValue({ id: 'message-1' });

      await service.addMessage(CLAIM_ID, ADMIN_ACTOR, 'Nota interna');

      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID },
      });
      expect(prisma.claimMessage.create).toHaveBeenCalledWith({
        data: {
          claimId: CLAIM_ID,
          authorUserId: 'admin-user',
          authorRole: 'ADMIN',
          body: 'Nota interna',
        },
      });
      // ADMIN nunca altera o VALOR do status por enviar uma mensagem --
      // o guard CAS ainda roda (sempre roda, pra toda mensagem, ver teste
      // de concorrência abaixo), mas escreve o mesmo status já lido
      // (no-op funcional).
      expect(prisma.claim.updateMany).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, status: ClaimStatus.OPEN },
        data: { status: ClaimStatus.OPEN },
      });
    });

    it('rejects with 409 when the claim is CLOSED (fase terminal)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.CLOSED }),
      );

      await expect(
        service.addMessage(CLAIM_ID, CUSTOMER_ACTOR, 'Olá'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.claimMessage.create).not.toHaveBeenCalled();
    });

    it('customer message moves status to SELLER_RESPONSE_REQUIRED', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claimMessage.create.mockResolvedValue({ id: 'message-1' });

      await service.addMessage(CLAIM_ID, CUSTOMER_ACTOR, 'Olá');

      expect(prisma.claim.updateMany).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, status: ClaimStatus.OPEN },
        data: { status: ClaimStatus.SELLER_RESPONSE_REQUIRED },
      });
    });

    it('seller message moves status to CUSTOMER_RESPONSE_REQUIRED', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claimMessage.create.mockResolvedValue({ id: 'message-1' });

      await service.addMessage(CLAIM_ID, SELLER_ACTOR, 'Vamos resolver');

      expect(prisma.claim.updateMany).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, status: ClaimStatus.OPEN },
        data: { status: ClaimStatus.CUSTOMER_RESPONSE_REQUIRED },
      });
    });

    // Teste D (pedido desta rodada): addMessage não pode sobrescrever um
    // status concorrente (ESCALATED/CLOSED/RESOLVED) a partir de uma
    // leitura obsoleta -- simulado aqui fazendo o CAS (claim.updateMany)
    // reportar count: 0, como aconteceria se outra escrita já tivesse
    // movido a Claim pra fora de CLAIM_STATUSES_OPEN_FOR_INPUT entre a
    // leitura (findClaimForActor) e o commit deste updateMany.
    it('não sobrescreve um status concorrente (ESCALATED/CLOSED/RESOLVED) a partir de leitura obsoleta (CAS count=0)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claim.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.addMessage(CLAIM_ID, CUSTOMER_ACTOR, 'Olá'),
      ).rejects.toBeInstanceOf(ConflictException);

      // A mensagem nunca é criada quando o CAS falha -- nem a mensagem
      // nem a mudança de status persistem isoladamente.
      expect(prisma.claimMessage.create).not.toHaveBeenCalled();
    });
  });

  describe('addEvidence — mesmo padrão de ownership de addMessage', () => {
    it('customer próprio -> PASS', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claimEvidence.create.mockResolvedValue({ id: 'evidence-1' });

      await service.addEvidence(CLAIM_ID, CUSTOMER_ACTOR, evidenceDto());

      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, customerId: CUSTOMER_ID },
      });
      expect(prisma.claimEvidence.create).toHaveBeenCalledWith({
        data: {
          claimId: CLAIM_ID,
          uploadedByUserId: ACTOR_USER_ID,
          uploadedByRole: 'CUSTOMER',
          storageKey: 'claims/evidence-1',
          fileName: 'foto.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 1024,
        },
      });
    });

    it('customer de terceiro -> 404', async () => {
      prisma.claim.findFirst.mockResolvedValue(null);

      await expect(
        service.addEvidence(CLAIM_ID, OTHER_CUSTOMER_ACTOR, evidenceDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.claimEvidence.create).not.toHaveBeenCalled();
    });

    it('seller próprio -> PASS', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claimEvidence.create.mockResolvedValue({ id: 'evidence-1' });

      await service.addEvidence(CLAIM_ID, SELLER_ACTOR, evidenceDto());

      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, sellerId: SELLER_ID },
      });
    });

    it('seller de outro tenant -> 404', async () => {
      prisma.claim.findFirst.mockResolvedValue(null);

      await expect(
        service.addEvidence(CLAIM_ID, OTHER_SELLER_ACTOR, evidenceDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.claimEvidence.create).not.toHaveBeenCalled();
    });

    it('admin -> PASS (sem escopo de tenant)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claimEvidence.create.mockResolvedValue({ id: 'evidence-1' });

      await service.addEvidence(CLAIM_ID, ADMIN_ACTOR, evidenceDto());

      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID },
      });
    });

    it('404s when the claim does not exist', async () => {
      prisma.claim.findFirst.mockResolvedValue(null);

      await expect(
        service.addEvidence(CLAIM_ID, CUSTOMER_ACTOR, evidenceDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.claimEvidence.create).not.toHaveBeenCalled();
    });

    it('evidência é escrita dentro de uma transaction interativa (CAS + criação atômicas)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claimEvidence.create.mockResolvedValue({ id: 'evidence-1' });

      await service.addEvidence(CLAIM_ID, CUSTOMER_ACTOR, evidenceDto());

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // Guard CAS no-op: addEvidence nunca altera Claim.status, então o
      // data escrito é o próprio status lido (claim.status === OPEN).
      expect(prisma.claim.updateMany).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, status: ClaimStatus.OPEN },
        data: { status: ClaimStatus.OPEN },
      });
    });

    for (const status of [
      ClaimStatus.ESCALATED,
      ClaimStatus.RESOLVED,
      ClaimStatus.CLOSED,
      ClaimStatus.CANCELLED,
    ]) {
      it(`rejects with 409 when the claim is ${status} (fase terminal / fora de CLAIM_STATUSES_OPEN_FOR_INPUT)`, async () => {
        prisma.claim.findFirst.mockResolvedValue(claimRow({ status }));

        await expect(
          service.addEvidence(CLAIM_ID, CUSTOMER_ACTOR, evidenceDto()),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.claimEvidence.create).not.toHaveBeenCalled();
        expect(prisma.claim.updateMany).not.toHaveBeenCalled();
      });
    }

    // Risco residual fechado nesta rodada: a Claim muda pra fora de
    // CLAIM_STATUSES_OPEN_FOR_INPUT ENTRE a leitura (findClaimForActor) e
    // o commit do CAS -- simulado fazendo claim.updateMany reportar
    // count: 0, como aconteceria se um transitionStatus/addMessage/
    // openFromClaimOrigin concorrente já tivesse movido a Claim nesse
    // intervalo. A evidência nunca é criada isoladamente.
    it('não cria evidência quando a Claim muda concorrentemente entre leitura e commit (CAS count=0)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claim.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.addEvidence(CLAIM_ID, CUSTOMER_ACTOR, evidenceDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.claimEvidence.create).not.toHaveBeenCalled();
    });
  });

  describe('transitionStatus — máquina de estados + ownership + autorização por papel', () => {
    it('customer de terceiro -> 404 (ownership aplicada antes da máquina de estados)', async () => {
      prisma.claim.findFirst.mockResolvedValue(null);

      await expect(
        service.transitionStatus(
          CLAIM_ID,
          OTHER_CUSTOMER_ACTOR,
          ClaimStatus.CANCELLED,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.claim.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an invalid machine transition (CLOSED -> OPEN) with 409, mesmo pro dono', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.CLOSED }),
      );

      await expect(
        service.transitionStatus(CLAIM_ID, CUSTOMER_ACTOR, ClaimStatus.OPEN),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.claim.updateMany).not.toHaveBeenCalled();
    });

    it('CUSTOMER próprio pode CANCELLED enquanto ainda não escalada/resolvida', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claim.findUnique.mockResolvedValue(
        claimRow({ status: ClaimStatus.CANCELLED }),
      );

      await service.transitionStatus(
        CLAIM_ID,
        CUSTOMER_ACTOR,
        ClaimStatus.CANCELLED,
      );

      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, customerId: CUSTOMER_ID },
      });
      // CAS: a WHERE do updateMany reconfirma o status lido (OPEN) além do id
      expect(prisma.claim.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CLAIM_ID, status: ClaimStatus.OPEN },
          data: expect.objectContaining({ status: ClaimStatus.CANCELLED }),
        }),
      );
    });

    it('CUSTOMER não pode ESCALATED diretamente (403), mesmo sendo dono e a máquina permitindo', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );

      await expect(
        service.transitionStatus(
          CLAIM_ID,
          CUSTOMER_ACTOR,
          ClaimStatus.ESCALATED,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.claim.updateMany).not.toHaveBeenCalled();
    });

    it('CUSTOMER não controla estados internos de espera do seller (403)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );

      await expect(
        service.transitionStatus(
          CLAIM_ID,
          CUSTOMER_ACTOR,
          ClaimStatus.SELLER_RESPONSE_REQUIRED,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // Teste E (pedido explícito desta rodada): SELLER não terá transição
    // manual de status no P0 -- CLAIM_ROLE_TARGETS[Role.SELLER] agora é
    // uma lista vazia, então QUALQUER alvo é 403 pro SELLER, mesmo um
    // alvo que a máquina de estados permitiria estruturalmente.
    it('SELLER NÃO pode chamar transitionStatus pra NENHUM alvo (403) -- lista vazia no P0', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );

      for (const target of [
        ClaimStatus.CUSTOMER_RESPONSE_REQUIRED,
        ClaimStatus.SELLER_RESPONSE_REQUIRED,
        ClaimStatus.RESOLVED,
        ClaimStatus.ESCALATED,
        ClaimStatus.CANCELLED,
      ]) {
        await expect(
          service.transitionStatus(CLAIM_ID, SELLER_ACTOR, target),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(prisma.claim.updateMany).not.toHaveBeenCalled();
    });

    it('SELLER de outro tenant -> 404 antes mesmo de chegar na autorização por papel', async () => {
      prisma.claim.findFirst.mockResolvedValue(null);

      await expect(
        service.transitionStatus(
          CLAIM_ID,
          OTHER_SELLER_ACTOR,
          ClaimStatus.CUSTOMER_RESPONSE_REQUIRED,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // CUSTOMER pode RESOLVED na própria Claim (pedido desta rodada, confirmação explícita)
    it('CUSTOMER próprio pode RESOLVED', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claim.findUnique.mockResolvedValue(
        claimRow({ status: ClaimStatus.RESOLVED }),
      );

      await service.transitionStatus(
        CLAIM_ID,
        CUSTOMER_ACTOR,
        ClaimStatus.RESOLVED,
      );

      expect(prisma.claim.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CLAIM_ID, status: ClaimStatus.OPEN },
          data: expect.objectContaining({ status: ClaimStatus.RESOLVED }),
        }),
      );
    });

    it('ADMIN pode ESCALATED/CLOSED/RESOLVED globalmente, mas não CANCELLED (403)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claim.findUnique.mockResolvedValue(
        claimRow({ status: ClaimStatus.ESCALATED }),
      );

      await service.transitionStatus(
        CLAIM_ID,
        ADMIN_ACTOR,
        ClaimStatus.ESCALATED,
      );
      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID },
      });

      await expect(
        service.transitionStatus(CLAIM_ID, ADMIN_ACTOR, ClaimStatus.CANCELLED),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // ADMIN pode RESOLVED (pedido desta rodada, confirmação explícita)
    it('ADMIN pode RESOLVED', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claim.findUnique.mockResolvedValue(
        claimRow({ status: ClaimStatus.RESOLVED }),
      );

      await service.transitionStatus(
        CLAIM_ID,
        ADMIN_ACTOR,
        ClaimStatus.RESOLVED,
      );

      expect(prisma.claim.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: ClaimStatus.RESOLVED }),
        }),
      );
    });

    // Teste C (pedido desta rodada): transitionStatus detecta uma mudança
    // concorrente -- simulado fazendo o CAS (claim.updateMany) reportar
    // count: 0, como aconteceria se outra escrita (addMessage, uma
    // segunda transitionStatus, ou DisputesService.openFromClaimOrigin)
    // já tivesse alterado o status da Claim entre a leitura
    // (findClaimForActor) e o commit deste updateMany.
    it('detecta mudança concorrente de status (CAS count=0) e lança Conflict em vez de sobrescrever', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimRow({ status: ClaimStatus.OPEN }),
      );
      prisma.claim.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.transitionStatus(
          CLAIM_ID,
          CUSTOMER_ACTOR,
          ClaimStatus.RESOLVED,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.claim.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CLAIM_ID, status: ClaimStatus.OPEN },
        }),
      );
    });
  });
});
