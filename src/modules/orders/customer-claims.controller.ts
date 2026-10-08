import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ClaimStatus } from '@prisma/client';
import { ClaimsService } from './claims.service';
import { DisputesService } from './disputes.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { AddClaimMessageDto } from './dto/add-claim-message.dto';
import { AddClaimEvidenceDto } from './dto/add-claim-evidence.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { Role } from '../../common/types/identity-enums';
import { PostSaleActor } from '../../common/types/post-sale-actor';

/**
 * Pós-venda do CUSTOMER (Claim/Dispute) -- mesmo prefixo 'orders' do
 * OrdersController, porém em controller separado (ver claude/
 * plano-pos-venda-reclamacoes-devolucoes-disputas.md). PostSaleActor é
 * montado aqui SOMENTE a partir de @CurrentUser() (request.authUser,
 * preenchido pelo SessionAuthGuard global) -- nunca de customerId/role
 * vindos do corpo/query. ClaimsService/DisputesService permanecem a
 * única autoridade de domínio (ownership, state machine, CAS); este
 * controller não duplica nenhuma dessas checagens.
 *
 * IMPORTANTE (registro no OrdersModule): este controller precisa ser
 * registrado ANTES de OrdersController no array `controllers` --
 * GET /orders/claims (1 segmento estático) colide em forma com
 * GET /orders/:id (1 segmento dinâmico) de OrdersController; quem for
 * registrado primeiro ganha o match no Express/Nest (mesmo raciocínio
 * já documentado nos comentários de OrdersController sobre
 * 'returns'/'reviews'/'coupons'/'favorites' vs. seu próprio ':id').
 *
 * Não existe endpoint genérico onde o CUSTOMER envie o status (alvo)
 * pelo corpo -- resolve/cancel são rotas fixas, cada uma com seu
 * targetStatus fixo no código, que delegam a validação real (state
 * machine + papel) para ClaimsService.transitionStatus.
 */
@ApiTags('customer-claims')
@ApiBearerAuth()
@Controller('orders')
@Roles(Role.CUSTOMER)
export class CustomerClaimsController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly disputesService: DisputesService,
  ) {}

  private buildActor(user: AuthenticatedUser): PostSaleActor {
    return { role: Role.CUSTOMER, userId: user.id, customerId: user.id };
  }

  @Get('claims')
  @ApiOperation({
    summary: "Lists the authenticated customer's own claims, newest first.",
  })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.claimsService.listForCustomer(user.id, query);
  }

  @Get('claims/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      "Fetches one of the authenticated customer's own claims, including messages and evidence.",
  })
  @ApiResponse({
    status: 404,
    description:
      "Claim does not exist, or belongs to a different customer (never distinguished from the caller's perspective).",
  })
  async getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.claimsService.getForCustomer(user.id, id);
  }

  @Post(':orderId/items/:itemId/claim')
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOperation({
    summary:
      "Opens a claim for one of the authenticated customer's own order items.",
  })
  @ApiResponse({ status: 201, description: 'Claim created.' })
  @ApiResponse({
    status: 404,
    description:
      "Order item does not exist, or does not belong to the caller's order (never distinguished from the caller's perspective).",
  })
  @ApiResponse({
    status: 409,
    description: 'The seller order is not yet eligible for a claim.',
  })
  async createClaim(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Body() dto: CreateClaimDto,
  ) {
    return this.claimsService.createClaim(user.id, orderId, itemId, dto);
  }

  @Post('claims/:id/messages')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Adds a message to one of the claims the customer is a party to.',
  })
  @ApiResponse({
    status: 409,
    description: 'This claim is no longer open for new messages.',
  })
  async addMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AddClaimMessageDto,
  ) {
    return this.claimsService.addMessage(id, this.buildActor(user), dto.body);
  }

  @Post('claims/:id/evidence')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      'Attaches evidence metadata to one of the claims the customer is a party to (metadata only -- no file upload in this stage).',
  })
  @ApiResponse({
    status: 409,
    description: 'This claim is no longer open for new evidence.',
  })
  async addEvidence(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AddClaimEvidenceDto,
  ) {
    return this.claimsService.addEvidence(id, this.buildActor(user), dto);
  }

  @Patch('claims/:id/resolve')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Customer marks one of their own claims as resolved.',
  })
  @ApiResponse({
    status: 409,
    description: 'The claim cannot move to RESOLVED from its current status.',
  })
  async resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.claimsService.transitionStatus(
      id,
      this.buildActor(user),
      ClaimStatus.RESOLVED,
    );
  }

  @Patch('claims/:id/cancel')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Customer cancels one of their own claims.' })
  @ApiResponse({
    status: 409,
    description: 'The claim cannot move to CANCELLED from its current status.',
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.claimsService.transitionStatus(
      id,
      this.buildActor(user),
      ClaimStatus.CANCELLED,
    );
  }

  @Post('claims/:id/dispute')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      'Escalates one of the claims the customer is a party to into a Dispute.',
  })
  @ApiResponse({
    status: 201,
    description: 'Dispute opened; the originating claim moves to ESCALATED.',
  })
  @ApiResponse({
    status: 409,
    description:
      'The claim is not in an eligible status, or already has a dispute.',
  })
  async openDisputeFromClaim(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.disputesService.openFromClaim(this.buildActor(user), id);
  }

  @Post('returns/:id/dispute')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      'Escalates one of the returns the customer is a party to into a Dispute.',
  })
  @ApiResponse({
    status: 201,
    description: 'Dispute opened; the originating return moves to CONTESTED.',
  })
  @ApiResponse({
    status: 409,
    description:
      'The return is not in an eligible status, or already has a dispute.',
  })
  async openDisputeFromReturn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.disputesService.openFromReturn(this.buildActor(user), id);
  }

  @Get('disputes/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      'Fetches a dispute the authenticated customer is a party to (originated from either their own Claim or Return).',
  })
  @ApiResponse({
    status: 404,
    description:
      "Dispute does not exist, or its originating Claim/Return does not belong to this customer (never distinguished from the caller's perspective).",
  })
  async getDispute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.disputesService.getForCustomer(user.id, id);
  }
}
