import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ClaimStatus,
  DisputeOutcome,
  DisputeStatus,
  Prisma,
  ReturnStatus,
} from '@prisma/client';
import { DisputesService } from './disputes.service';
import { createPrismaMock, PrismaMock } from '../../test-utils/prisma.mock';
import { Role } from '../../common/types/identity-enums';
import { PostSaleActor } from '../../common/types/post-sale-actor';
import { RecordDisputeDecisionDto } from './dto/record-dispute-decision.dto';

const CLAIM_ID = '00000000-0000-4000-8000-000000009001';
const RETURN_ID = '00000000-0000-4000-8000-0000000000d1';
const DISPUTE_ID = '00000000-0000-4000-8000-000000008001';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000c01';
const OTHER_CUSTOMER_ID = '00000000-0000-4000-8000-000000000c02';
const SELLER_ID = '00000000-0000-4000-8000-00000000a003';
const OTHER_SELLER_ID = '00000000-0000-4000-8000-00000000a099';
const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000a01';

const CUSTOMER_ACTOR: PostSaleActor = {
  role: Role.CUSTOMER,
  userId: 'customer-user',
  customerId: CUSTOMER_ID,
};
const OTHER_CUSTOMER_ACTOR: PostSaleActor = {
  role: Role.CUSTOMER,
  userId: 'other-customer-user',
  customerId: OTHER_CUSTOMER_ID,
};
const SELLER_ACTOR: PostSaleActor = {
  role: Role.SELLER,
  userId: 'seller-user',
  sellerId: SELLER_ID,
};
const ADMIN_ACTOR: PostSaleActor = { role: Role.ADMIN, userId: ADMIN_USER_ID };

function decisionDto(
  overrides: Partial<RecordDisputeDecisionDto> = {},
): RecordDisputeDecisionDto {
  return {
    outcome: DisputeOutcome.CUSTOMER_FAVORED,
    reason: 'Produto comprovadamente com defeito.',
    ...overrides,
  } as RecordDisputeDecisionDto;
}

function disputeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DISPUTE_ID,
    claimId: null,
    returnId: null,
    status: DisputeStatus.OPEN,
    outcome: null,
    resolvedAt: null,
    closedAt: null,
    ...overrides,
  };
}

function claimOriginRow(
  status: ClaimStatus,
  overrides: Record<string, unknown> = {},
) {
  return { id: CLAIM_ID, status, dispute: null, ...overrides };
}

function returnOriginRow(
  status: ReturnStatus,
  overrides: Record<string, unknown> = {},
) {
  return { id: RETURN_ID, status, dispute: null, ...overrides };
}

function uniqueDisputeOriginViolation(
  column: 'reclamacao_id' | 'devolucao_id',
) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target: [column] },
  });
}

describe('DisputesService', () => {
  let prisma: PrismaMock;
  let service: DisputesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new DisputesService(prisma as never);
  });

  /**
   * Mesma invariante crítica de claims.service.spec.ts: DisputesService
   * NUNCA pode chamar order.update/sellerOrder.update/.updateMany, nem
   * em recordDecision/open -- a abertura de Dispute só pode alterar
   * Claim.status -> ESCALATED OU Return.status -> CONTESTED, conforme a
   * origem, nunca as duas simultaneamente (ver afterEach de cada
   * describe de origem abaixo).
   */
  afterEach(() => {
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.sellerOrder.update).not.toHaveBeenCalled();
    expect(prisma.sellerOrder.updateMany).not.toHaveBeenCalled();
  });

  describe('open — XOR de origem', () => {
    it('rejects opening a dispute with zero origins', async () => {
      await expect(service.open(ADMIN_ACTOR, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.dispute.create).not.toHaveBeenCalled();
    });

    it('rejects opening a dispute with both claimId and returnId set', async () => {
      await expect(
        service.open(ADMIN_ACTOR, { claimId: CLAIM_ID, returnId: RETURN_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.dispute.create).not.toHaveBeenCalled();
    });
  });

  describe('openFromClaim — allow-list de ClaimStatus + ownership + atomicidade', () => {
    afterEach(() => {
      // Nunca a Return.status é tocada ao escalar a partir de uma Claim
      expect(prisma.return.update).not.toHaveBeenCalled();
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    for (const status of [
      ClaimStatus.OPEN,
      ClaimStatus.SELLER_RESPONSE_REQUIRED,
      ClaimStatus.CUSTOMER_RESPONSE_REQUIRED,
    ]) {
      it(`${status} pode escalar`, async () => {
        prisma.claim.findFirst.mockResolvedValue(claimOriginRow(status));
        prisma.dispute.create.mockResolvedValue(
          disputeRow({ claimId: CLAIM_ID }),
        );
        prisma.claim.updateMany.mockResolvedValue({ count: 1 });

        const result = await service.openFromClaim(CUSTOMER_ACTOR, CLAIM_ID);

        expect(result).toEqual(disputeRow({ claimId: CLAIM_ID }));
      });
    }

    for (const status of [
      ClaimStatus.RESOLVED,
      ClaimStatus.CLOSED,
      ClaimStatus.CANCELLED,
      ClaimStatus.ESCALATED,
    ]) {
      it(`${status} não pode escalar (409)`, async () => {
        prisma.claim.findFirst.mockResolvedValue(claimOriginRow(status));

        await expect(
          service.openFromClaim(CUSTOMER_ACTOR, CLAIM_ID),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.dispute.create).not.toHaveBeenCalled();
        expect(prisma.claim.updateMany).not.toHaveBeenCalled();
      });
    }

    it('criação da Dispute + Claim.status -> ESCALATED é atômica (transaction interativa + CAS)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimOriginRow(ClaimStatus.OPEN),
      );
      prisma.dispute.create.mockResolvedValue(
        disputeRow({ claimId: CLAIM_ID }),
      );
      prisma.claim.updateMany.mockResolvedValue({ count: 1 });

      await service.openFromClaim(CUSTOMER_ACTOR, CLAIM_ID);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // O CAS reconfirma, na própria WHERE, que a Claim ainda está num
      // status elegível (Array.from(CLAIM_ORIGIN_ELIGIBLE_STATUSES))
      expect(prisma.claim.updateMany).toHaveBeenCalledWith({
        where: {
          id: CLAIM_ID,
          status: {
            in: [
              ClaimStatus.OPEN,
              ClaimStatus.SELLER_RESPONSE_REQUIRED,
              ClaimStatus.CUSTOMER_RESPONSE_REQUIRED,
            ],
          },
        },
        data: { status: ClaimStatus.ESCALATED },
      });
      expect(prisma.dispute.create).toHaveBeenCalledWith({
        data: { claimId: CLAIM_ID, returnId: undefined },
      });
    });

    it('se dispute.create falhar (P2002/duplicidade), Claim NÃO fica ESCALATED isoladamente', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimOriginRow(ClaimStatus.OPEN),
      );
      prisma.claim.updateMany.mockResolvedValue({ count: 1 });
      prisma.dispute.create.mockRejectedValue(
        uniqueDisputeOriginViolation('reclamacao_id'),
      );

      await expect(
        service.openFromClaim(CUSTOMER_ACTOR, CLAIM_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      // Roteado por uma transaction INTERATIVA agora -- o mock invoca o
      // callback passando o próprio mock como tx, então a rejeição de
      // dispute.create propaga da mesma forma que propagaria num rollback
      // real do Prisma (a garantia de que o banco de fato desfaz o
      // claim.updateMany já comitado dentro da mesma transaction é do
      // Prisma em runtime, fora do alcance deste mock -- aqui garantimos
      // que o CÓDIGO nunca aplica os dois efeitos por fora de uma única
      // $transaction interativa).
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    // Teste A (pedido desta rodada): a Claim muda pra um status
    // inelegível ENTRE a leitura (findClaimOriginForActor) e o commit do
    // CAS -- simulado fazendo claim.updateMany reportar count: 0, como
    // aconteceria se um transitionStatus/addMessage concorrente já
    // tivesse movido a Claim pra fora da allow-list nesse intervalo.
    // Nem a Dispute persiste nem a Claim fica ESCALATED isoladamente.
    it('detecta a Claim saindo da allow-list entre leitura e commit (CAS count=0) -- nem Dispute nem ESCALATED', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimOriginRow(ClaimStatus.OPEN),
      );
      prisma.claim.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.openFromClaim(CUSTOMER_ACTOR, CLAIM_ID),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.dispute.create).not.toHaveBeenCalled();
    });

    it('customer dono -> PASS (tenant-scoped em SQL)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimOriginRow(ClaimStatus.OPEN),
      );
      prisma.dispute.create.mockResolvedValue(
        disputeRow({ claimId: CLAIM_ID }),
      );

      await service.openFromClaim(CUSTOMER_ACTOR, CLAIM_ID);

      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, customerId: CUSTOMER_ID },
        include: { dispute: true },
      });
    });

    it('customer de outro tenant -> 404 (nunca "buscar por id e filtrar depois")', async () => {
      prisma.claim.findFirst.mockResolvedValue(null);

      await expect(
        service.openFromClaim(OTHER_CUSTOMER_ACTOR, CLAIM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, customerId: OTHER_CUSTOMER_ID },
        include: { dispute: true },
      });
      expect(prisma.dispute.create).not.toHaveBeenCalled();
    });

    it('seller dono -> PASS', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimOriginRow(ClaimStatus.OPEN),
      );
      prisma.dispute.create.mockResolvedValue(
        disputeRow({ claimId: CLAIM_ID }),
      );

      await service.openFromClaim(SELLER_ACTOR, CLAIM_ID);

      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, sellerId: SELLER_ID },
        include: { dispute: true },
      });
    });

    it('admin -> PASS globalmente (sem escopo de tenant)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimOriginRow(ClaimStatus.OPEN),
      );
      prisma.dispute.create.mockResolvedValue(
        disputeRow({ claimId: CLAIM_ID }),
      );

      await service.openFromClaim(ADMIN_ACTOR, CLAIM_ID);

      expect(prisma.claim.findFirst).toHaveBeenCalledWith({
        where: { id: CLAIM_ID },
        include: { dispute: true },
      });
    });

    it('rejects a second dispute for the same claim (pre-check via the loaded relation)', async () => {
      prisma.claim.findFirst.mockResolvedValue(
        claimOriginRow(ClaimStatus.OPEN, {
          dispute: { id: 'existing-dispute' },
        }),
      );

      await expect(
        service.openFromClaim(CUSTOMER_ACTOR, CLAIM_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.dispute.create).not.toHaveBeenCalled();
    });
  });

  describe('openFromReturn — allow-list de ReturnStatus + ownership + atomicidade', () => {
    afterEach(() => {
      // Nunca a Claim.status é tocada ao abrir disputa a partir de uma Return
      expect(prisma.claim.update).not.toHaveBeenCalled();
      expect(prisma.claim.updateMany).not.toHaveBeenCalled();
    });

    for (const status of [
      ReturnStatus.REQUESTED,
      ReturnStatus.APPROVED,
      ReturnStatus.REJECTED,
      ReturnStatus.AWAITING_SHIPMENT,
      ReturnStatus.SHIPPED,
      ReturnStatus.RECEIVED,
      ReturnStatus.UNDER_REVIEW,
    ]) {
      it(`${status} abre disputa`, async () => {
        prisma.return.findFirst.mockResolvedValue(returnOriginRow(status));
        prisma.dispute.create.mockResolvedValue(
          disputeRow({ returnId: RETURN_ID }),
        );
        prisma.return.updateMany.mockResolvedValue({ count: 1 });

        const result = await service.openFromReturn(CUSTOMER_ACTOR, RETURN_ID);

        expect(result).toEqual(disputeRow({ returnId: RETURN_ID }));
      });
    }

    for (const status of [
      ReturnStatus.COMPLETED,
      ReturnStatus.CONTESTED,
      ReturnStatus.CANCELLED,
    ]) {
      it(`${status} não abre disputa (409)`, async () => {
        prisma.return.findFirst.mockResolvedValue(returnOriginRow(status));

        await expect(
          service.openFromReturn(CUSTOMER_ACTOR, RETURN_ID),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.dispute.create).not.toHaveBeenCalled();
        expect(prisma.return.updateMany).not.toHaveBeenCalled();
      });
    }

    it('criação da Dispute + Return.status -> CONTESTED é atômica (transaction interativa + CAS)', async () => {
      prisma.return.findFirst.mockResolvedValue(
        returnOriginRow(ReturnStatus.REQUESTED),
      );
      prisma.dispute.create.mockResolvedValue(
        disputeRow({ returnId: RETURN_ID }),
      );
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.openFromReturn(CUSTOMER_ACTOR, RETURN_ID);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.return.updateMany).toHaveBeenCalledWith({
        where: {
          id: RETURN_ID,
          status: {
            in: [
              ReturnStatus.REQUESTED,
              ReturnStatus.APPROVED,
              ReturnStatus.REJECTED,
              ReturnStatus.AWAITING_SHIPMENT,
              ReturnStatus.SHIPPED,
              ReturnStatus.RECEIVED,
              ReturnStatus.UNDER_REVIEW,
            ],
          },
        },
        data: { status: ReturnStatus.CONTESTED },
      });
      expect(prisma.dispute.create).toHaveBeenCalledWith({
        data: { claimId: undefined, returnId: RETURN_ID },
      });
    });

    it('se a criação da Dispute falhar, Return NÃO fica CONTESTED isoladamente', async () => {
      prisma.return.findFirst.mockResolvedValue(
        returnOriginRow(ReturnStatus.REQUESTED),
      );
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      prisma.dispute.create.mockRejectedValue(
        uniqueDisputeOriginViolation('devolucao_id'),
      );

      await expect(
        service.openFromReturn(CUSTOMER_ACTOR, RETURN_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    // Teste B (pedido desta rodada): mesma race do Teste A, espelhada pra
    // Return -- muda pra um status inelegível (ou já foi decidida via
    // ReturnsService.decide) ENTRE a leitura e o commit do CAS. Nem a
    // Dispute persiste nem a Return fica CONTESTED isoladamente.
    it('detecta a Return saindo da allow-list entre leitura e commit (CAS count=0) -- nem Dispute nem CONTESTED', async () => {
      prisma.return.findFirst.mockResolvedValue(
        returnOriginRow(ReturnStatus.REQUESTED),
      );
      prisma.return.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.openFromReturn(CUSTOMER_ACTOR, RETURN_ID),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.dispute.create).not.toHaveBeenCalled();
    });

    it('customer dono -> PASS', async () => {
      prisma.return.findFirst.mockResolvedValue(
        returnOriginRow(ReturnStatus.REQUESTED),
      );
      prisma.dispute.create.mockResolvedValue(
        disputeRow({ returnId: RETURN_ID }),
      );
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.openFromReturn(CUSTOMER_ACTOR, RETURN_ID);

      expect(prisma.return.findFirst).toHaveBeenCalledWith({
        where: { id: RETURN_ID, customerId: CUSTOMER_ID },
        include: { dispute: true },
      });
    });

    it('customer de outro tenant -> 404', async () => {
      prisma.return.findFirst.mockResolvedValue(null);

      await expect(
        service.openFromReturn(OTHER_CUSTOMER_ACTOR, RETURN_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.dispute.create).not.toHaveBeenCalled();
    });
  });

  describe('admin methods — defesa em profundidade', () => {
    it('getForAdmin 404s when the dispute does not exist (para ADMIN)', async () => {
      prisma.dispute.findFirst.mockResolvedValue(null);

      await expect(
        service.getForAdmin(ADMIN_ACTOR, DISPUTE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getForAdmin rejects non-ADMIN actors with 403, mesmo sem tocar o banco', async () => {
      await expect(
        service.getForAdmin(CUSTOMER_ACTOR, DISPUTE_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.dispute.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('getForCustomer/getForSeller — tenant-scoped via relações claim/return, já que Dispute não tem customerId/sellerId próprios (nova rodada: leituras de disputa)', () => {
    function tenantDisputeRow(overrides: Record<string, unknown> = {}) {
      return {
        id: DISPUTE_ID,
        claimId: null,
        returnId: null,
        status: DisputeStatus.OPEN,
        outcome: null,
        openedAt: new Date('2026-01-01'),
        resolvedAt: null,
        closedAt: null,
        decisions: [],
        ...overrides,
      };
    }

    describe('getForCustomer', () => {
      it('lê uma dispute originada da própria Claim do customer', async () => {
        const row = tenantDisputeRow({ claimId: CLAIM_ID });
        prisma.dispute.findFirst.mockResolvedValue(row);

        const result = await service.getForCustomer(CUSTOMER_ID, DISPUTE_ID);

        expect(prisma.dispute.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: DISPUTE_ID,
              OR: [
                { claim: { customerId: CUSTOMER_ID } },
                { return: { customerId: CUSTOMER_ID } },
              ],
            },
          }),
        );
        expect(result).toEqual(row);
      });

      it('lê uma dispute originada da própria Return do customer', async () => {
        const row = tenantDisputeRow({ returnId: RETURN_ID });
        prisma.dispute.findFirst.mockResolvedValue(row);

        const result = await service.getForCustomer(CUSTOMER_ID, DISPUTE_ID);

        expect(result).toEqual(row);
      });

      it('404s para uma dispute de outro customer (o OR na própria query não bate em nenhuma linha)', async () => {
        prisma.dispute.findFirst.mockResolvedValue(null);

        await expect(
          service.getForCustomer(OTHER_CUSTOMER_ID, DISPUTE_ID),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('404s para uma dispute inexistente -- indistinguível do caso de outro tenant, de propósito', async () => {
        prisma.dispute.findFirst.mockResolvedValue(null);

        await expect(
          service.getForCustomer(CUSTOMER_ID, DISPUTE_ID),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('expõe os dados da decisão quando a dispute já foi resolvida, sem decidedByUserId (identificador administrativo)', async () => {
        const row = tenantDisputeRow({
          claimId: CLAIM_ID,
          status: DisputeStatus.RESOLVED,
          outcome: DisputeOutcome.CUSTOMER_FAVORED,
          resolvedAt: new Date('2026-02-01'),
          decisions: [
            {
              outcome: DisputeOutcome.CUSTOMER_FAVORED,
              reason: 'Produto comprovadamente com defeito.',
              createdAt: new Date('2026-02-01'),
            },
          ],
        });
        prisma.dispute.findFirst.mockResolvedValue(row);

        const result = await service.getForCustomer(CUSTOMER_ID, DISPUTE_ID);

        expect(result.decisions).toEqual(row.decisions);
        expect(prisma.dispute.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            select: expect.objectContaining({
              decisions: {
                select: { outcome: true, reason: true, createdAt: true },
              },
            }),
          }),
        );
      });
    });

    describe('getForSeller', () => {
      it('lê uma dispute de Claim da própria loja', async () => {
        const row = tenantDisputeRow({ claimId: CLAIM_ID });
        prisma.dispute.findFirst.mockResolvedValue(row);

        const result = await service.getForSeller(SELLER_ID, DISPUTE_ID);

        expect(prisma.dispute.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: DISPUTE_ID,
              OR: [
                { claim: { sellerId: SELLER_ID } },
                { return: { sellerId: SELLER_ID } },
              ],
            },
          }),
        );
        expect(result).toEqual(row);
      });

      it('lê uma dispute de Return da própria loja', async () => {
        const row = tenantDisputeRow({ returnId: RETURN_ID });
        prisma.dispute.findFirst.mockResolvedValue(row);

        const result = await service.getForSeller(SELLER_ID, DISPUTE_ID);

        expect(result).toEqual(row);
      });

      it('não alcança a dispute de outra loja', async () => {
        prisma.dispute.findFirst.mockResolvedValue(null);

        await expect(
          service.getForSeller(OTHER_SELLER_ID, DISPUTE_ID),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('404s para uma dispute inexistente', async () => {
        prisma.dispute.findFirst.mockResolvedValue(null);

        await expect(
          service.getForSeller(SELLER_ID, DISPUTE_ID),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });

  describe('recordDecision — somente ADMIN, atômico, append-only, protegido por CAS', () => {
    it('customer não decide (403)', async () => {
      await expect(
        service.recordDecision(DISPUTE_ID, CUSTOMER_ACTOR, decisionDto()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.dispute.findUnique).not.toHaveBeenCalled();
      expect(prisma.disputeDecision.create).not.toHaveBeenCalled();
    });

    it('seller não decide (403)', async () => {
      await expect(
        service.recordDecision(DISPUTE_ID, SELLER_ACTOR, decisionDto()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.disputeDecision.create).not.toHaveBeenCalled();
    });

    it('admin decide -> cria decisão (append-only) e atualiza Dispute.status/outcome via transaction interativa + CAS', async () => {
      prisma.dispute.findUnique.mockResolvedValue(
        disputeRow({ status: DisputeStatus.OPEN }),
      );
      prisma.dispute.updateMany.mockResolvedValue({ count: 1 });
      prisma.disputeDecision.create.mockResolvedValue({
        id: 'decision-1',
        disputeId: DISPUTE_ID,
        decidedByUserId: ADMIN_USER_ID,
        outcome: DisputeOutcome.CUSTOMER_FAVORED,
      });

      const result = await service.recordDecision(
        DISPUTE_ID,
        ADMIN_ACTOR,
        decisionDto(),
      );

      // decidedByUserId vem do actor, nunca de um campo do DTO
      expect(prisma.disputeDecision.create).toHaveBeenCalledWith({
        data: {
          disputeId: DISPUTE_ID,
          decidedByUserId: ADMIN_USER_ID,
          outcome: DisputeOutcome.CUSTOMER_FAVORED,
          reason: 'Produto comprovadamente com defeito.',
        },
      });
      // Atomicidade: CAS (updateMany) + decisão passam pela MESMA transaction interativa
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // CAS: a WHERE reconfirma o status lido (OPEN) além do id
      expect(prisma.dispute.updateMany).toHaveBeenCalledWith({
        where: { id: DISPUTE_ID, status: DisputeStatus.OPEN },
        data: expect.objectContaining({
          outcome: DisputeOutcome.CUSTOMER_FAVORED,
          status: DisputeStatus.RESOLVED,
        }),
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: 'decision-1',
          outcome: DisputeOutcome.CUSTOMER_FAVORED,
        }),
      );
    });

    it('rejects with 409 when the dispute is already CLOSED (imutável)', async () => {
      prisma.dispute.findUnique.mockResolvedValue(
        disputeRow({ status: DisputeStatus.CLOSED }),
      );

      await expect(
        service.recordDecision(DISPUTE_ID, ADMIN_ACTOR, decisionDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.disputeDecision.create).not.toHaveBeenCalled();
      expect(prisma.dispute.updateMany).not.toHaveBeenCalled();
    });

    // Achado do risco residual desta rodada: antes, só CLOSED bloqueava
    // uma nova decisão -- uma Dispute já RESOLVED (mas não CLOSED) ainda
    // aceitava outra decisão, o que permitia sobrescrever outcome/status
    // de uma decisão já tomada sem nenhuma corrida nem sequer envolvida.
    // Regra P0 explícita agora: RESOLVED bloqueia igual a CLOSED.
    it('rejects with 409 when the dispute is already RESOLVED -- revisão é fluxo futuro explícito, fora de escopo', async () => {
      prisma.dispute.findUnique.mockResolvedValue(
        disputeRow({
          status: DisputeStatus.RESOLVED,
          outcome: DisputeOutcome.CUSTOMER_FAVORED,
        }),
      );

      await expect(
        service.recordDecision(DISPUTE_ID, ADMIN_ACTOR, decisionDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.disputeDecision.create).not.toHaveBeenCalled();
      expect(prisma.dispute.updateMany).not.toHaveBeenCalled();
    });

    it('404s when the dispute does not exist', async () => {
      prisma.dispute.findUnique.mockResolvedValue(null);

      await expect(
        service.recordDecision(DISPUTE_ID, ADMIN_ACTOR, decisionDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('falha de uma etapa não produz estado parcial: rejection do $transaction propaga, decisão anterior continua existindo', async () => {
      prisma.dispute.findUnique.mockResolvedValue(
        disputeRow({ status: DisputeStatus.OPEN }),
      );
      prisma.dispute.updateMany.mockResolvedValue({ count: 1 });
      const dbError = new Error('connection reset mid-transaction');
      prisma.disputeDecision.create.mockRejectedValue(dbError);

      await expect(
        service.recordDecision(DISPUTE_ID, ADMIN_ACTOR, decisionDto()),
      ).rejects.toBe(dbError);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    // Cenário exato do pedido: Admin A e Admin B leem a mesma Dispute OPEN
    // concorrentemente; A decide primeiro (CAS ganha, count: 1); quando B
    // tenta decidir em seguida com o mesmo status-base já obsoleto, o CAS
    // de B encontra count: 0 (o status no banco já é RESOLVED, não mais
    // OPEN) -- Conflict pra B, nenhuma segunda DisputeDecision persiste,
    // e o outcome/status de A não é sobrescrito.
    it('duas decisões concorrentes na mesma Dispute OPEN -- a segunda recebe Conflict e não sobrescreve a primeira', async () => {
      prisma.dispute.findUnique.mockResolvedValue(
        disputeRow({ status: DisputeStatus.OPEN }),
      );
      // Simula A já tendo ganho a corrida: quando B tenta, a CAS de B
      // (baseada na mesma leitura obsoleta de OPEN) encontra count: 0.
      prisma.dispute.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.recordDecision(
          DISPUTE_ID,
          ADMIN_ACTOR,
          decisionDto({ outcome: DisputeOutcome.SELLER_FAVORED }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      // Nenhuma segunda DisputeDecision persiste quando o CAS falha
      expect(prisma.disputeDecision.create).not.toHaveBeenCalled();
    });
  });
});
