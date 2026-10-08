import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ClaimAuthorRole,
  ClaimStatus,
  SellerOrderStatus,
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
import { CreateClaimDto } from './dto/create-claim.dto';
import { AddClaimEvidenceDto } from './dto/add-claim-evidence.dto';

/**
 * SellerOrderStatus elegíveis pra abrir uma Claim -- pedido explícito
 * desta rodada: Claim é pós-venda de um pedido já CONFIRMED em diante,
 * nunca de um pedido ainda com pagamento pendente (PENDING, fora do
 * escopo deste fluxo) nem de um pedido já CANCELLED (nada "pós-venda" a
 * reclamar de um pedido que nunca se concretizou -- consequência direta
 * da mesma allow-list, não pedida explicitamente mas sinalizada no
 * relatório). Diferente de Review/Return (que exigem DELIVERED): Claim
 * aceita qualquer fase "em andamento" porque problemas como "item nunca
 * chegou" podem surgir antes da entrega.
 */
const CLAIM_ELIGIBLE_SELLER_ORDER_STATUSES: ReadonlySet<SellerOrderStatus> =
  new Set([
    SellerOrderStatus.CONFIRMED,
    SellerOrderStatus.PREPARING,
    SellerOrderStatus.SHIPPED,
    SellerOrderStatus.DELIVERED,
  ]);

/**
 * Valid ClaimStatus transitions for ClaimsService.transitionStatus --
 * camada de MÁQUINA DE ESTADOS, puramente estrutural (independe de quem
 * está chamando -- ver CLAIM_ROLE_TARGETS abaixo pra autorização por
 * papel, aplicada em cima desta tabela). OPEN/SELLER_RESPONSE_REQUIRED/
 * CUSTOMER_RESPONSE_REQUIRED são as fases "em conversa" e podem se mover
 * entre si ou terminar em RESOLVED/ESCALATED/CANCELLED; RESOLVED e
 * ESCALATED só fecham; CLOSED e CANCELLED são terminais.
 */
const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  [ClaimStatus.OPEN]: [
    ClaimStatus.SELLER_RESPONSE_REQUIRED,
    ClaimStatus.CUSTOMER_RESPONSE_REQUIRED,
    ClaimStatus.RESOLVED,
    ClaimStatus.ESCALATED,
    ClaimStatus.CANCELLED,
  ],
  [ClaimStatus.SELLER_RESPONSE_REQUIRED]: [
    ClaimStatus.CUSTOMER_RESPONSE_REQUIRED,
    ClaimStatus.RESOLVED,
    ClaimStatus.ESCALATED,
    ClaimStatus.CANCELLED,
  ],
  [ClaimStatus.CUSTOMER_RESPONSE_REQUIRED]: [
    ClaimStatus.SELLER_RESPONSE_REQUIRED,
    ClaimStatus.RESOLVED,
    ClaimStatus.ESCALATED,
    ClaimStatus.CANCELLED,
  ],
  [ClaimStatus.RESOLVED]: [ClaimStatus.CLOSED],
  [ClaimStatus.ESCALATED]: [ClaimStatus.CLOSED],
  [ClaimStatus.CLOSED]: [],
  [ClaimStatus.CANCELLED]: [],
};

/**
 * Camada de AUTORIZAÇÃO POR PAPEL sobre a máquina de estados acima --
 * pedido desta rodada (regra mínima P0). O alvo final só é permitido se
 * estiver em AMBAS as tabelas (máquina E papel). Decisões de design
 * tomadas pra resolver os pontos ambíguos do pedido, flagadas no
 * relatório:
 * - CUSTOMER nunca alcança ESCALATED diretamente (pedido: "não pode
 *   ESCALATED diretamente se a regra exigir mediação automática" --
 *   interpretado como: escalar pra mediação formal é sempre um ato
 *   administrativo, nunca uma auto-declaração do cliente) nem
 *   SELLER_RESPONSE_REQUIRED/CUSTOMER_RESPONSE_REQUIRED (pedido: "não
 *   controla estados internos de espera do seller arbitrariamente" --
 *   esses dois só mudam via addMessage, nunca via transitionStatus
 *   direto do cliente).
 * - SELLER NÃO TEM NENHUM ALVO MANUAL EM transitionStatus NO P0 (pedido
 *   explícito desta rodada: "SELLER não terá transição manual de status
 *   no P0" -- lista vazia, de propósito). Isto supera a regra da rodada
 *   anterior que ainda permitia CUSTOMER_RESPONSE_REQUIRED manualmente:
 *   esse status só nasce de addMessage após uma mensagem do próprio
 *   SELLER (ver nextStatusAfterMessage abaixo), nunca de uma chamada
 *   direta a transitionStatus -- a via manual era funcionalmente
 *   redundante com addMessage e deixava o SELLER "declarar" ter
 *   respondido sem de fato registrar nenhuma ClaimMessage (achado da
 *   auditoria de race condition). RESOLVED ("SELLER não pode encerrar
 *   sozinho uma reclamação aberta contra sua própria loja" -- a resolução
 *   final depende de CUSTOMER ou ADMIN) e CANCELLED seguem bloqueados
 *   pelo mesmo raciocínio de rodadas anteriores.
 * - ADMIN só tem os três alvos explicitamente listados no pedido
 *   (ESCALATED/CLOSED/RESOLVED); CANCELLED não foi listado pro admin e
 *   não foi adicionado por conta própria.
 */
const CLAIM_ROLE_TARGETS: Record<Role, ClaimStatus[]> = {
  [Role.CUSTOMER]: [ClaimStatus.CANCELLED, ClaimStatus.RESOLVED],
  [Role.SELLER]: [],
  [Role.ADMIN]: [
    ClaimStatus.ESCALATED,
    ClaimStatus.CLOSED,
    ClaimStatus.RESOLVED,
  ],
};

/** Phases that still accept new messages/evidence -- the three "live conversation" statuses above. Once RESOLVED/ESCALATED/CLOSED/CANCELLED, the thread is read-only from here. */
const CLAIM_STATUSES_OPEN_FOR_INPUT: ReadonlySet<ClaimStatus> = new Set([
  ClaimStatus.OPEN,
  ClaimStatus.SELLER_RESPONSE_REQUIRED,
  ClaimStatus.CUSTOMER_RESPONSE_REQUIRED,
]);

/** Role (identity-enums.ts, TS puro) -> ClaimAuthorRole (enum Prisma deste schema) -- mesmos valores de string, convertido explicitamente em vez de cast, ver comentário do model ClaimMessage em schema.prisma sobre por que são dois enums distintos. */
function toClaimAuthorRole(role: Role): ClaimAuthorRole {
  switch (role) {
    case Role.CUSTOMER:
      return ClaimAuthorRole.CUSTOMER;
    case Role.SELLER:
      return ClaimAuthorRole.SELLER;
    case Role.ADMIN:
      return ClaimAuthorRole.ADMIN;
  }
}

/**
 * Reclamações (pós-venda, fundação P0 -- ver
 * claude/plano-pos-venda-reclamacoes-devolucoes-disputas.md e o comentário
 * do model Claim em schema.prisma). Mesmo raciocínio de dono-do-dado de
 * ReviewsService/ReturnsService: este serviço já é dono de
 * Order/SellerOrder/OrderItem.
 *
 * NUNCA escreve em Order.status ou SellerOrder.status -- pós-venda não
 * controla o ciclo de vida de fulfillment, só o seu próprio
 * (ClaimStatus).
 */
@Injectable()
export class ClaimsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Full order-context-chain validation: orderItemId precisa pertencer ao
   * sellerOrder do orderId informado, que por sua vez precisa pertencer ao
   * customerId autenticado -- mesmo raciocínio de 404 indistinguível já
   * usado em toda escrita autenticada deste serviço (ver
   * ReturnsService.createReturn). sellerOrderId e sellerId (snapshot) são
   * derivados da cadeia, nunca aceitos do corpo da requisição. Elegível
   * somente quando SellerOrder.status está em
   * CLAIM_ELIGIBLE_SELLER_ORDER_STATUSES (ver constante acima) --
   * PENDING/CANCELLED são rejeitados com 409.
   */
  async createClaim(
    customerId: string,
    orderId: string,
    orderItemId: string,
    dto: CreateClaimDto,
  ) {
    const orderItem = await this.prisma.orderItem.findFirst({
      where: {
        id: orderItemId,
        sellerOrder: { orderId, order: { customerId } },
      },
      include: { sellerOrder: true },
    });

    if (!orderItem) {
      throw new NotFoundException('Order item not found');
    }

    if (
      !CLAIM_ELIGIBLE_SELLER_ORDER_STATUSES.has(orderItem.sellerOrder.status)
    ) {
      throw new ConflictException(
        'A claim can only be opened once the seller order is confirmed',
      );
    }

    return this.prisma.claim.create({
      data: {
        orderId,
        sellerOrderId: orderItem.sellerOrder.id,
        orderItemId: orderItem.id,
        customerId,
        sellerId: orderItem.sellerOrder.sellerId,
        reason: dto.reason,
        description: dto.description,
      },
    });
  }

  /** Tenant-scoped in SQL, same 404-not-403 reasoning as OrdersService.getForCustomer. */
  async getForCustomer(customerId: string, claimId: string) {
    const claim = await this.prisma.claim.findFirst({
      where: { id: claimId, customerId },
      include: {
        messages: true,
        evidence: true,
        dispute: {
          select: {
            id: true,
            status: true,
            outcome: true,
            openedAt: true,
            resolvedAt: true,
          },
        },
      },
    });
    if (!claim) {
      throw new NotFoundException('Claim not found');
    }
    return claim;
  }

  async listForCustomer(customerId: string, query: PaginationQueryDto = {}) {
    const { limit, cursor } = resolvePagination(query);

    await requireCursor(cursor, async (id) => {
      const claim = await this.prisma.claim.findFirst({
        where: { id, customerId },
        select: { id: true },
      });
      return claim !== null;
    });

    const rows = await this.prisma.claim.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      where: { customerId },
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });

    return buildPage(rows, limit);
  }

  /** Tenant-scoped by sellerId, same reasoning as getForCustomer above. */
  async getForSeller(sellerId: string, claimId: string) {
    const claim = await this.prisma.claim.findFirst({
      where: { id: claimId, sellerId },
      include: {
        messages: true,
        evidence: true,
        dispute: {
          select: {
            id: true,
            status: true,
            outcome: true,
            openedAt: true,
            resolvedAt: true,
          },
        },
      },
    });
    if (!claim) {
      throw new NotFoundException('Claim not found');
    }
    return claim;
  }

  async listForSeller(sellerId: string, query: PaginationQueryDto = {}) {
    const { limit, cursor } = resolvePagination(query);

    await requireCursor(cursor, async (id) => {
      const claim = await this.prisma.claim.findFirst({
        where: { id, sellerId },
        select: { id: true },
      });
      return claim !== null;
    });

    const rows = await this.prisma.claim.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      where: { sellerId },
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });

    return buildPage(rows, limit);
  }

  /**
   * Admin, marketplace-wide -- sem where de tenant, mesmo raciocínio de
   * ReturnsService.listForAdmin. Defesa em profundidade desta rodada:
   * exige actor.role === ADMIN (nunca chamada remota a identity-service
   * -- o contexto autenticado já resolvido pelos guards é a fonte de
   * verdade), pra não depender só de um futuro RolesGuard no controller.
   */
  async getForAdmin(actor: PostSaleActor, claimId: string) {
    this.assertAdmin(actor);

    const claim = await this.prisma.claim.findFirst({
      where: { id: claimId },
      include: {
        messages: true,
        evidence: true,
        dispute: {
          select: {
            id: true,
            status: true,
            outcome: true,
            openedAt: true,
            resolvedAt: true,
          },
        },
      },
    });
    if (!claim) {
      throw new NotFoundException('Claim not found');
    }
    return claim;
  }

  async listForAdmin(actor: PostSaleActor, query: PaginationQueryDto = {}) {
    this.assertAdmin(actor);

    const { limit, cursor } = resolvePagination(query);

    await requireCursor(cursor, async (id) => {
      const claim = await this.prisma.claim.findFirst({
        where: { id },
        select: { id: true },
      });
      return claim !== null;
    });

    const rows = await this.prisma.claim.findMany({
      ...prismaIdCursorArgs(limit, cursor),
      orderBy: PAGINATION_ORDER_CREATED_AT_ID_DESC,
    });

    return buildPage(rows, limit);
  }

  /**
   * Valid-transitions-only (CLAIM_TRANSITIONS) E autorização por papel
   * (CLAIM_ROLE_TARGETS), ambas aplicadas aqui -- não depende mais de um
   * controller futuro validar isso (achado da auditoria anterior,
   * corrigido nesta rodada). Ownership via findClaimForActor abaixo:
   * CUSTOMER/SELLER só alcançam a própria Claim (404, nunca 403, mesmo
   * raciocínio de 404 indistinguível do resto do projeto); ADMIN é
   * global.
   */
  async transitionStatus(
    claimId: string,
    actor: PostSaleActor,
    targetStatus: ClaimStatus,
  ) {
    const existing = await this.findClaimForActor(claimId, actor);
    if (!existing) {
      throw new NotFoundException('Claim not found');
    }

    const allowedByMachine = CLAIM_TRANSITIONS[existing.status] ?? [];
    if (!allowedByMachine.includes(targetStatus)) {
      throw new ConflictException(
        `Cannot move claim from ${existing.status} to ${targetStatus}`,
      );
    }

    const allowedByRole = CLAIM_ROLE_TARGETS[actor.role] ?? [];
    if (!allowedByRole.includes(targetStatus)) {
      throw new ForbiddenException(
        `${actor.role} is not allowed to move a claim to ${targetStatus}`,
      );
    }

    // CAS: a escrita só comita se o status no banco ainda for exatamente
    // o status lido/validado acima (existing.status) -- achado da
    // auditoria de race condition (rodada anterior): findClaimForActor e
    // este update não eram atômicos entre si, então um addMessage ou uma
    // segunda transitionStatus concorrente podia mudar o status entre a
    // leitura e a escrita, e o update (where só por id) sobrescrevia essa
    // mudança silenciosamente (last-write-wins a partir de leitura
    // obsoleta). updateMany com o status na própria WHERE relê e escreve
    // como uma única operação atômica do banco; count === 0 significa que
    // a leitura ficou obsoleta.
    const result = await this.prisma.claim.updateMany({
      where: { id: claimId, status: existing.status },
      data: {
        status: targetStatus,
        resolvedAt:
          targetStatus === ClaimStatus.RESOLVED
            ? new Date()
            : existing.resolvedAt,
      },
    });

    if (result.count === 0) {
      throw new ConflictException(
        'The claim status changed concurrently; please retry',
      );
    }

    return this.prisma.claim.findUnique({ where: { id: claimId } });
  }

  /**
   * authorUserId/authorRole vêm exclusivamente de `actor` (contexto de
   * autenticação), nunca do corpo da requisição -- ver comentário do
   * model ClaimMessage em schema.prisma. Ownership via findClaimForActor
   * (tenant-scoped em SQL, nunca "busca por id e filtra depois" -- achado
   * da auditoria anterior, corrigido nesta rodada). Uma mensagem de
   * CUSTOMER/SELLER também empurra o ping-pong de status (CUSTOMER ->
   * SELLER_RESPONSE_REQUIRED, SELLER -> CUSTOMER_RESPONSE_REQUIRED);
   * ADMIN nunca altera o status por enviar uma mensagem. Rejeitado fora
   * das três fases "em conversa" (ver CLAIM_STATUSES_OPEN_FOR_INPUT).
   */
  async addMessage(claimId: string, actor: PostSaleActor, body: string) {
    const claim = await this.findClaimForActor(claimId, actor);
    if (!claim) {
      throw new NotFoundException('Claim not found');
    }
    if (!CLAIM_STATUSES_OPEN_FOR_INPUT.has(claim.status)) {
      throw new ConflictException(
        'This claim is no longer open for new messages',
      );
    }

    const nextStatus = this.nextStatusAfterMessage(actor.role);
    const statusToWrite =
      nextStatus && nextStatus !== claim.status ? nextStatus : claim.status;

    // CAS: mensagem e mudança de status (quando houver) são escritas como
    // UMA operação lógica atômica -- achado da auditoria de race
    // condition (rodada anterior): findClaimForActor acima e a escrita
    // anterior (claimMessage.create + claim.update sequenciais, nem
    // atômicos entre si nem protegidos contra leitura obsoleta) não
    // detectavam uma Claim que saiu de CLAIM_STATUSES_OPEN_FOR_INPUT
    // (ex.: ESCALATED/CLOSED/RESOLVED via transitionStatus ou
    // openFromClaimOrigin) entre a leitura e a escrita -- o claim.update
    // antigo (where só por id) sobrescrevia essa mudança concorrente
    // silenciosamente, e a mensagem era aceita mesmo assim. Agora: dentro
    // de uma transaction interativa, um updateMany com claim.status (o
    // valor lido acima) na própria WHERE relê e escreve como uma única
    // operação atômica do banco (sempre, mesmo pra ADMIN, cujo
    // statusToWrite é o próprio claim.status -- um no-op que ainda serve
    // de guarda); count !== 1 significa que a leitura ficou obsoleta, e o
    // throw aqui dentro desfaz tudo (inclusive a mensagem, que nunca é
    // criada numa Claim que deixou de estar aberta entre leitura e
    // escrita).
    return this.prisma.$transaction(async (tx) => {
      const guard = await tx.claim.updateMany({
        where: { id: claimId, status: claim.status },
        data: { status: statusToWrite },
      });

      if (guard.count !== 1) {
        throw new ConflictException(
          'This claim is no longer open for new messages',
        );
      }

      return tx.claimMessage.create({
        data: {
          claimId,
          authorUserId: actor.userId,
          authorRole: toClaimAuthorRole(actor.role),
          body,
        },
      });
    });
  }

  /**
   * Re-auditado nesta rodada (pedido: "audite a lógica atual de
   * addMessage" + objetivo semântico explícito) -- comportamento já
   * correto, preservado sem alteração: mensagem de CUSTOMER deixa a
   * próxima resposta esperada com o SELLER
   * (SELLER_RESPONSE_REQUIRED); mensagem de SELLER deixa a próxima
   * resposta esperada com o CUSTOMER (CUSTOMER_RESPONSE_REQUIRED);
   * ADMIN nunca altera esse estado automaticamente (retorna null). Essa
   * é a ÚNICA via pela qual SELLER_RESPONSE_REQUIRED é alcançado --
   * CLAIM_ROLE_TARGETS acima nunca permite ao próprio seller escolher
   * esse valor manualmente via transitionStatus.
   */
  private nextStatusAfterMessage(role: Role): ClaimStatus | null {
    if (role === Role.CUSTOMER) {
      return ClaimStatus.SELLER_RESPONSE_REQUIRED;
    }
    if (role === Role.SELLER) {
      return ClaimStatus.CUSTOMER_RESPONSE_REQUIRED;
    }
    return null;
  }

  /**
   * Metadata only -- nenhum upload real nesta rodada (ver comentário do
   * model ClaimEvidence em schema.prisma). uploadedByUserId/
   * uploadedByRole vêm exclusivamente de `actor`, mesmo raciocínio de
   * addMessage acima. Mesma restrição de ownership (findClaimForActor) e
   * de fase que addMessage.
   *
   * CAS (achado da auditoria de riscos residuais, rodada seguinte à de
   * race condition): a mesma janela existia aqui -- a Claim podia sair
   * de CLAIM_STATUSES_OPEN_FOR_INPUT (ESCALATED/RESOLVED/CLOSED/
   * CANCELLED) entre a leitura (findClaimForActor) e a criação da
   * evidência, e a evidência era criada mesmo assim. Protegido agora com
   * o mesmo padrão de addMessage: dentro de uma transaction interativa,
   * um updateMany com claim.status (o valor lido acima) na própria WHERE
   * serve de guarda atômica -- como addEvidence NUNCA altera
   * Claim.status (diferente de addMessage), o `data` escrito é sempre o
   * próprio claim.status, um no-op funcional que só existe pra
   * reconfirmar, de forma atômica, que a Claim ainda está na mesma fase
   * no momento do commit; count !== 1 -> ConflictException, e a
   * ClaimEvidence nunca é criada isoladamente.
   */
  async addEvidence(
    claimId: string,
    actor: PostSaleActor,
    dto: AddClaimEvidenceDto,
  ) {
    const claim = await this.findClaimForActor(claimId, actor);
    if (!claim) {
      throw new NotFoundException('Claim not found');
    }
    if (!CLAIM_STATUSES_OPEN_FOR_INPUT.has(claim.status)) {
      throw new ConflictException(
        'This claim is no longer open for new evidence',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const guard = await tx.claim.updateMany({
        where: { id: claimId, status: claim.status },
        data: { status: claim.status },
      });

      if (guard.count !== 1) {
        throw new ConflictException(
          'This claim is no longer open for new evidence',
        );
      }

      return tx.claimEvidence.create({
        data: {
          claimId,
          uploadedByUserId: actor.userId,
          uploadedByRole: toClaimAuthorRole(actor.role),
          storageKey: dto.storageKey,
          fileName: dto.fileName,
          mimeType: dto.mimeType,
          sizeBytes: dto.sizeBytes,
        },
      });
    });
  }

  /**
   * Busca tenant-scoped EM SQL para operações que mutam uma Claim
   * (addMessage/addEvidence/transitionStatus) -- CUSTOMER/SELLER recebem
   * um WHERE que já exclui Claims que não são suas (404, nunca 403,
   * mesmo raciocínio de todo 404 indistinguível do resto do projeto, não
   * "buscar só por claimId e filtrar depois" -- achado da auditoria
   * anterior, corrigido nesta rodada); ADMIN não tem essa restrição.
   */
  private async findClaimForActor(claimId: string, actor: PostSaleActor) {
    if (actor.role === Role.CUSTOMER) {
      return this.prisma.claim.findFirst({
        where: { id: claimId, customerId: actor.customerId },
      });
    }
    if (actor.role === Role.SELLER) {
      return this.prisma.claim.findFirst({
        where: { id: claimId, sellerId: actor.sellerId },
      });
    }
    return this.prisma.claim.findFirst({ where: { id: claimId } });
  }

  private assertAdmin(actor: PostSaleActor): void {
    if (actor.role !== Role.ADMIN) {
      throw new ForbiddenException('Only ADMIN may perform this operation');
    }
  }
}
