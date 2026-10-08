import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ClaimStatus,
  DisputeStatus,
  Prisma,
  ReturnStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  buildPage,
  PAGINATION_ORDER_CREATED_AT_ID_DESC,
  prismaIdCursorArgs,
  requireCursor,
  resolvePagination,
} from '../../common/pagination/pagination';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { Role } from '../../common/types/identity-enums';
import { PostSaleActor } from '../../common/types/post-sale-actor';
import { RecordDisputeDecisionDto } from './dto/record-dispute-decision.dto';

type DisputeOrigin = { claimId?: string; returnId?: string };

/**
 * Allow-list de ClaimStatus elegíveis pra abrir uma Dispute a partir de
 * uma Claim -- pedido explícito desta rodada, achado da auditoria
 * anterior (antes, qualquer status, inclusive RESOLVED/CLOSED/
 * CANCELLED, permitia abrir disputa). Coincide com os únicos status de
 * onde a própria máquina de ClaimsService (CLAIM_TRANSITIONS, privada
 * àquele módulo) alcança ESCALATED -- mas definido aqui de forma
 * independente, de propósito: DisputesService nunca importa o estado
 * interno de ClaimsService, cada serviço é dono da sua própria regra.
 */
const CLAIM_ORIGIN_ELIGIBLE_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  ClaimStatus.OPEN,
  ClaimStatus.SELLER_RESPONSE_REQUIRED,
  ClaimStatus.CUSTOMER_RESPONSE_REQUIRED,
]);

/**
 * Allow-list de ReturnStatus elegíveis pra abrir uma Dispute a partir de
 * uma Return -- mesmo raciocínio e mesmo pedido desta rodada. COMPLETED/
 * CONTESTED/CANCELLED bloqueados: um Return já concluído ou cancelado
 * não tem mais nada a contestar formalmente, e um Return já CONTESTED
 * cairia no pre-check de dispute duplicada de qualquer forma.
 */
const RETURN_ORIGIN_ELIGIBLE_STATUSES: ReadonlySet<ReturnStatus> = new Set([
  ReturnStatus.REQUESTED,
  ReturnStatus.APPROVED,
  ReturnStatus.REJECTED,
  ReturnStatus.AWAITING_SHIPMENT,
  ReturnStatus.SHIPPED,
  ReturnStatus.RECEIVED,
  ReturnStatus.UNDER_REVIEW,
]);

/**
 * Allow-list de DisputeStatus elegíveis pra RECEBER uma decisão --
 * pedido explícito desta rodada (achado do risco residual: antes, só
 * CLOSED bloqueava; RESOLVED não bloqueava, então uma segunda decisão
 * concorrente, ou mesmo sequencial, podia sobrescrever outcome/status
 * de uma Dispute já decidida). Regra P0: uma vez RESOLVED ou CLOSED, a
 * Dispute não aceita mais nenhuma decisão nova. DisputeDecision
 * continua append-only (nunca é apagada/atualizada), mas revisão
 * administrativa de uma decisão já tomada é um fluxo explícito futuro,
 * fora de escopo aqui -- CLOSED nunca esteve nesta lista (comportamento
 * preservado), RESOLVED sai dela nesta rodada.
 */
const DISPUTE_DECISION_ELIGIBLE_STATUSES: ReadonlySet<DisputeStatus> = new Set([
  DisputeStatus.OPEN,
  DisputeStatus.UNDER_REVIEW,
  DisputeStatus.WAITING_CUSTOMER,
  DisputeStatus.WAITING_SELLER,
]);

/**
 * Mediação formal (pós-venda, fundação P0 -- ver o comentário do model
 * Dispute em schema.prisma). Nasce de uma Claim OU de uma Return
 * contestada, nunca das duas, nunca de nenhuma -- a mesma regra que o
 * CHECK manual `disputas_origem_unica_check` impõe no banco é validada
 * aqui primeiro, pra devolver um erro claro em vez de uma violação de
 * constraint crua (mesmo raciocínio de todo pre-check já usado neste
 * serviço). NUNCA escreve em Order.status ou SellerOrder.status, e NUNCA
 * implementa reembolso/estorno -- isso é escopo de outra rodada (ver
 * pedido original).
 */
@Injectable()
export class DisputesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Conveniências tipadas sobre `open` abaixo -- existem só pra deixar o
   * caller mais claro quando já se sabe a origem; o `open` público é o
   * ponto de entrada real (e o único jeito de exercitar a validação de
   * zero/duas origens -- openFromClaim/openFromReturn sempre fixam
   * exatamente uma por construção, então essa validação é inalcançável
   * através deles).
   */
  async openFromClaim(actor: PostSaleActor, claimId: string) {
    return this.open(actor, { claimId });
  }

  async openFromReturn(actor: PostSaleActor, returnId: string) {
    return this.open(actor, { returnId });
  }

  /**
   * XOR de claimId/returnId -- zero origens e duas origens são tratados
   * identicamente (BadRequest), nunca passam do validador de entrada.
   * Delega pra openFromClaimOrigin/openFromReturnOrigin abaixo, que
   * aplicam ownership, allow-list de status e a escrita atômica da
   * Claim/Return de origem.
   */
  async open(actor: PostSaleActor, origin: DisputeOrigin) {
    const hasClaim = Boolean(origin.claimId);
    const hasReturn = Boolean(origin.returnId);
    if (hasClaim === hasReturn) {
      throw new BadRequestException(
        'A dispute must originate from exactly one of claimId or returnId',
      );
    }

    if (origin.claimId) {
      return this.openFromClaimOrigin(origin.claimId, actor);
    }
    return this.openFromReturnOrigin(origin.returnId as string, actor);
  }

  /**
   * Origem referenciada precisa existir E pertencer ao `actor`
   * (CUSTOMER/SELLER -- 404 indistinguível pra origem de outro tenant;
   * ADMIN é global), ainda não ter uma Dispute (pre-check via sua
   * relação `dispute`, 409) E estar num ClaimStatus elegível
   * (CLAIM_ORIGIN_ELIGIBLE_STATUSES, pedido desta rodada: achado da
   * auditoria anterior era abrir disputa a partir de QUALQUER status,
   * inclusive RESOLVED/CLOSED/CANCELLED -- bloqueado agora).
   *
   * Claim.status -> ESCALATED e Dispute.create (status OPEN) acontecem
   * na MESMA transaction INTERATIVA ($transaction(async (tx) => {...}),
   * não mais a forma array -- rodada anterior usava a forma array, mas
   * ela não permite checar um count intermediário e abortar a
   * transaction a partir dele; esta rodada corrige a race condition
   * encontrada na auditoria: o claim.updateMany abaixo reconfirma, de
   * forma atômica, que a Claim ainda está num status elegível no
   * momento do COMMIT, não só no momento desta leitura). Se
   * dispute.create falhar (P2002/duplicidade, ou qualquer outro erro) OU
   * se o CAS do updateMany detectar uma mudança concorrente, a Claim NÃO
   * fica ESCALATED isoladamente -- tudo é revertido pelo rollback da
   * transaction interativa.
   */
  private async openFromClaimOrigin(claimId: string, actor: PostSaleActor) {
    const claim = await this.findClaimOriginForActor(claimId, actor);
    if (!claim) {
      throw new NotFoundException('Claim not found');
    }
    if (claim.dispute) {
      throw new ConflictException('A dispute already exists for this claim');
    }
    if (!CLAIM_ORIGIN_ELIGIBLE_STATUSES.has(claim.status)) {
      throw new ConflictException(
        `A dispute cannot be opened from a claim in status ${claim.status}`,
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // CAS: só escala se a Claim AINDA estiver num status elegível no
        // momento do commit -- achado da auditoria de race condition
        // (rodada anterior): a leitura acima (findClaimOriginForActor) e
        // este updateMany não são atômicos entre si, então um
        // transitionStatus/addMessage concorrente pode ter movido a Claim
        // pra fora da allow-list entre a leitura e aqui. updateMany com o
        // status na própria WHERE é a forma de reler e escrever como uma
        // única operação atômica do banco; count !== 1 significa que a
        // leitura ficou obsoleta, e o throw aqui dentro da transaction
        // interativa desfaz TUDO (inclusive um dispute.create já
        // executado neste mesmo callback) -- nunca fica uma Claim
        // ESCALATED sem a Dispute correspondente, nem vice-versa.
        const claimUpdate = await tx.claim.updateMany({
          where: {
            id: claimId,
            status: { in: Array.from(CLAIM_ORIGIN_ELIGIBLE_STATUSES) },
          },
          data: { status: ClaimStatus.ESCALATED },
        });
        if (claimUpdate.count !== 1) {
          throw new ConflictException(
            'The claim status changed concurrently; a dispute could not be opened',
          );
        }

        return tx.dispute.create({
          data: { claimId, returnId: undefined },
        });
      });
    } catch (error) {
      if (this.isDisputeOriginConflict(error)) {
        throw new ConflictException('A dispute already exists for this claim');
      }
      throw error;
    }
  }

  /**
   * Mesmo raciocínio de openFromClaimOrigin acima, espelhado pra Return
   * (ReturnStatus elegível via RETURN_ORIGIN_ELIGIBLE_STATUSES) --
   * Return.status -> CONTESTED e Dispute.create (status OPEN) na MESMA
   * transaction interativa, protegida pelo mesmo CAS via
   * return.updateMany: se dispute.create falhar OU o CAS detectar uma
   * mudança concorrente, Return NÃO fica CONTESTED isoladamente.
   */
  private async openFromReturnOrigin(returnId: string, actor: PostSaleActor) {
    const returnRequest = await this.findReturnOriginForActor(returnId, actor);
    if (!returnRequest) {
      throw new NotFoundException('Return not found');
    }
    if (returnRequest.dispute) {
      throw new ConflictException('A dispute already exists for this return');
    }
    if (!RETURN_ORIGIN_ELIGIBLE_STATUSES.has(returnRequest.status)) {
      throw new ConflictException(
        `A dispute cannot be opened from a return in status ${returnRequest.status}`,
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Mesmo CAS de openFromClaimOrigin acima, espelhado pra Return:
        // count !== 1 -> a Return deixou de estar num status elegível
        // entre a leitura e aqui (ex.: ReturnsService.decide ou outra
        // chamada concorrente a este mesmo método já decidiu/contestou a
        // Return) -- o throw dentro da transaction interativa desfaz tudo.
        const returnUpdate = await tx.return.updateMany({
          where: {
            id: returnId,
            status: { in: Array.from(RETURN_ORIGIN_ELIGIBLE_STATUSES) },
          },
          data: { status: ReturnStatus.CONTESTED },
        });
        if (returnUpdate.count !== 1) {
          throw new ConflictException(
            'The return status changed concurrently; a dispute could not be opened',
          );
        }

        return tx.dispute.create({
          data: { claimId: undefined, returnId },
        });
      });
    } catch (error) {
      if (this.isDisputeOriginConflict(error)) {
        throw new ConflictException('A dispute already exists for this return');
      }
      throw error;
    }
  }

  /**
   * Admin, marketplace-wide -- sem where de tenant, mesmo raciocínio de
   * ClaimsService.getForAdmin. Defesa em profundidade: exige actor.role
   * === ADMIN, nunca chamada remota a identity-service.
   */
  async getForAdmin(actor: PostSaleActor, disputeId: string) {
    this.assertAdmin(actor);

    const dispute = await this.prisma.dispute.findFirst({
      where: { id: disputeId },
      include: { decisions: true },
    });
    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }
    return dispute;
  }

  /**
   * Projeção explícita pra CUSTOMER/SELLER -- usada por getForCustomer e
   * getForSeller abaixo. Difere de getForAdmin (que usa `include: {
   * decisions: true }`, objeto completo) de propósito: exclui
   * DisputeDecision.decidedByUserId (identificador administrativo interno,
   * pedido explícito desta rodada: "especialmente identificadores
   * administrativos que não precisam ser exibidos ao cliente"). O
   * histórico completo de decisões já fica disponível aqui -- é só este
   * campo específico que nunca aparece fora de getForAdmin.
   */
  private static readonly TENANT_FACING_SELECT = {
    id: true,
    claimId: true,
    returnId: true,
    status: true,
    outcome: true,
    openedAt: true,
    resolvedAt: true,
    closedAt: true,
    decisions: {
      select: {
        outcome: true,
        reason: true,
        createdAt: true,
      },
    },
  } satisfies Prisma.DisputeSelect;

  /**
   * CUSTOMER -- Dispute não tem coluna customerId própria (ver model
   * Dispute em schema.prisma), então o ownership é verificado atravessando
   * as relações claim/return DIRETO NA QUERY (OR entre as duas origens
   * possíveis), nunca "buscar por id e filtrar depois": uma Dispute de
   * outro customer, ou sem nenhuma relação com este customer, bate em
   * nenhuma linha e cai no mesmo 404 de uma Dispute inexistente --
   * indistinguíveis de propósito. Mesmo raciocínio de
   * ClaimsService.getForCustomer/getForSeller e do restante deste módulo.
   */
  async getForCustomer(customerId: string, disputeId: string) {
    const dispute = await this.prisma.dispute.findFirst({
      where: {
        id: disputeId,
        OR: [{ claim: { customerId } }, { return: { customerId } }],
      },
      select: DisputesService.TENANT_FACING_SELECT,
    });
    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }
    return dispute;
  }

  /**
   * SELLER -- espelha getForCustomer acima. Atenção explícita desta
   * rodada: uma Dispute pode ter origem numa Claim OU numa Return, e o
   * seller da loja precisa alcançar as duas (daí o OR cobrindo claim.
   * sellerId e return.sellerId, não só uma das origens).
   */
  async getForSeller(sellerId: string, disputeId: string) {
    const dispute = await this.prisma.dispute.findFirst({
      where: {
        id: disputeId,
        OR: [{ claim: { sellerId } }, { return: { sellerId } }],
      },
      select: DisputesService.TENANT_FACING_SELECT,
    });
    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }
    return dispute;
  }

  async listForAdmin(actor: PostSaleActor, query: PaginationQueryDto = {}) {
    this.assertAdmin(actor);

    const { limit, cursor } = resolvePagination(query);

    await requireCursor(cursor, async (id) => {
      const dispute = await this.prisma.dispute.findFirst({
        where: { id },
        select: { id: true },
      });
      return dispute !== null;
    });

    const rows = await this.prisma.dispute.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });

    return buildPage(rows, limit);
  }

  /**
   * Append-only: DisputeDecision nunca é atualizada ou apagada, uma nova
   * decisão é sempre uma nova linha (ver comentário do model
   * DisputeDecision em schema.prisma). Dispute.outcome/status são
   * atualizados pra refletir a decisão "atual" de forma coerente
   * (status -> RESOLVED, resolvedAt preenchido), mas isso nunca
   * sobrescreve ou remove decisões passadas -- o histórico completo
   * continua em DisputeDecision.decisions.
   *
   * Exige actor.role === ADMIN -- decidedByUserId vem SEMPRE de
   * actor.userId, nunca do DTO.
   *
   * CAS (achado do risco residual desta rodada): dois ADMINs podiam ler
   * a mesma Dispute OPEN concorrentemente e ambos decidirem -- a forma
   * array de $transaction usada antes atomizava as duas escritas ENTRE
   * SI, mas não reconfirmava o status no momento do commit (mesma classe
   * de race já corrigida em ClaimsService/DisputesService.open* na
   * rodada anterior), então a segunda decisão sobrescrevia outcome/
   * status da primeira silenciosamente (last-write-wins), e DUAS
   * DisputeDecision persistiam pra uma Dispute que só devia aceitar a
   * primeira. Também achado: só CLOSED bloqueava decisão nova -- uma
   * Dispute já RESOLVED (mas não CLOSED) ainda aceitava outra decisão.
   * Regra P0 explícita agora: RESOLVED e CLOSED bloqueiam igualmente
   * (ver DISPUTE_DECISION_ELIGIBLE_STATUSES); revisão administrativa de
   * uma decisão já tomada é um fluxo explícito futuro, fora de escopo.
   *
   * Agora numa transaction INTERATIVA: o dispute.updateMany reconfirma,
   * de forma atômica, que o status no banco ainda é EXATAMENTE o status
   * lido acima (dispute.status) -- count !== 1 -> ConflictException
   * lançada dentro da transaction (rollback de tudo) -- e só então o
   * DisputeDecision.create roda no mesmo callback. Se a CAS falhar,
   * nenhuma segunda decisão persiste e nenhuma sobrescreve outcome/
   * status da que já ganhou a corrida.
   */
  async recordDecision(
    disputeId: string,
    actor: PostSaleActor,
    dto: RecordDisputeDecisionDto,
  ) {
    if (actor.role !== Role.ADMIN) {
      throw new ForbiddenException('Only ADMIN may record a dispute decision');
    }

    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
    });
    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }
    if (!DISPUTE_DECISION_ELIGIBLE_STATUSES.has(dispute.status)) {
      throw new ConflictException(
        'This dispute has already been decided and can no longer receive a new decision',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const guard = await tx.dispute.updateMany({
        where: { id: disputeId, status: dispute.status },
        data: {
          outcome: dto.outcome,
          status: DisputeStatus.RESOLVED,
          resolvedAt: new Date(),
        },
      });

      if (guard.count !== 1) {
        throw new ConflictException(
          'This dispute was decided concurrently; please reload and retry',
        );
      }

      return tx.disputeDecision.create({
        data: {
          disputeId,
          decidedByUserId: actor.userId,
          outcome: dto.outcome,
          reason: dto.reason,
        },
      });
    });
  }

  /**
   * Busca tenant-scoped EM SQL da Claim de origem -- CUSTOMER/SELLER só
   * alcançam uma Claim própria (404, nunca 403); ADMIN é global. Mesmo
   * raciocínio de ClaimsService.findClaimForActor.
   */
  private async findClaimOriginForActor(claimId: string, actor: PostSaleActor) {
    if (actor.role === Role.CUSTOMER) {
      return this.prisma.claim.findFirst({
        where: { id: claimId, customerId: actor.customerId },
        include: { dispute: true },
      });
    }
    if (actor.role === Role.SELLER) {
      return this.prisma.claim.findFirst({
        where: { id: claimId, sellerId: actor.sellerId },
        include: { dispute: true },
      });
    }
    return this.prisma.claim.findFirst({
      where: { id: claimId },
      include: { dispute: true },
    });
  }

  /** Mesmo raciocínio de findClaimOriginForActor acima, pra Return. */
  private async findReturnOriginForActor(
    returnId: string,
    actor: PostSaleActor,
  ) {
    if (actor.role === Role.CUSTOMER) {
      return this.prisma.return.findFirst({
        where: { id: returnId, customerId: actor.customerId },
        include: { dispute: true },
      });
    }
    if (actor.role === Role.SELLER) {
      return this.prisma.return.findFirst({
        where: { id: returnId, sellerId: actor.sellerId },
        include: { dispute: true },
      });
    }
    return this.prisma.return.findFirst({
      where: { id: returnId },
      include: { dispute: true },
    });
  }

  private assertAdmin(actor: PostSaleActor): void {
    if (actor.role !== Role.ADMIN) {
      throw new ForbiddenException('Only ADMIN may perform this operation');
    }
  }

  /** P2002 on Dispute.claimId/Dispute.returnId -- a race with the pre-check above, same shape as every other *Conflict helper in this module. */
  private isDisputeOriginConflict(error: unknown): boolean {
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
    return (
      target.includes('reclamacao_id') ||
      target.includes('devolucao_id') ||
      target.includes('claimid') ||
      target.includes('returnid')
    );
  }
}
