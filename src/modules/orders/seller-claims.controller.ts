import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ClaimsService } from './claims.service';
import { DisputesService } from './disputes.service';
import { AddClaimMessageDto } from './dto/add-claim-message.dto';
import { AddClaimEvidenceDto } from './dto/add-claim-evidence.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentSeller } from '../../common/decorators/current-seller.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  SellerActiveGuard,
  SellerContextGuard,
} from '../../common/guards/seller.guard';
import { Role } from '../../common/types/identity-enums';
import { SellerContext } from '../../common/types/authenticated-user';
import { PostSaleActor } from '../../common/types/post-sale-actor';

/**
 * Pós-venda do SELLER (Claim/Dispute). SellerContextGuard/
 * SellerActiveGuard resolvem sellerId sobre a rede (sellers-service),
 * mesmo padrão de SellerOrdersController. PostSaleActor é montado aqui
 * SOMENTE a partir de @CurrentSeller() (request.sellerContext) -- nunca
 * de sellerId/userId/role vindos do corpo. ClaimsService/DisputesService
 * permanecem a única autoridade de domínio.
 *
 * CRÍTICO: SELLER não tem transição manual de status de Claim nesta
 * API (CLAIM_ROLE_TARGETS[Role.SELLER] é vazio em claims.service.ts) --
 * por isso NÃO existem rotas resolve/cancel/close/escalate aqui. A
 * resposta do vendedor já move a Claim para CUSTOMER_RESPONSE_REQUIRED
 * automaticamente dentro de ClaimsService.addMessage(); nenhuma rota
 * adicional é necessária ou permitida para isso.
 *
 * Prefixo 'seller/claims' e 'seller/returns/:id/dispute' são literais
 * próprios, sem colisão de forma com 'seller/orders' (SellerOrdersController),
 * 'seller/reviews' (SellerReviewsController) ou 'seller/coupons'
 * (SellerCouponsController) -- cada um usa um segmento literal distinto
 * logo após 'seller/', então a ordem de registro no módulo é
 * irrelevante para este controller.
 */
@ApiTags('seller-claims')
@ApiBearerAuth()
@Controller('seller')
@Roles(Role.SELLER)
@UseGuards(SellerContextGuard, SellerActiveGuard)
export class SellerClaimsController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly disputesService: DisputesService,
  ) {}

  private buildActor(seller: SellerContext): PostSaleActor {
    return {
      role: Role.SELLER,
      userId: seller.userId,
      sellerId: seller.sellerId,
    };
  }

  @Get('claims')
  @ApiOperation({
    summary: "Lists the authenticated store's own claims, newest first.",
  })
  async list(
    @CurrentSeller() seller: SellerContext,
    @Query() query: PaginationQueryDto,
  ) {
    return this.claimsService.listForSeller(seller.sellerId, query);
  }

  @Get('claims/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      "Fetches one of the authenticated store's own claims, including messages and evidence.",
  })
  @ApiResponse({
    status: 404,
    description:
      "Claim does not exist, or belongs to a different store (never distinguished from the caller's perspective).",
  })
  async getOne(
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.claimsService.getForSeller(seller.sellerId, id);
  }

  @Post('claims/:id/messages')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      'Adds a message to one of the claims the store is a party to. Automatically moves the claim to CUSTOMER_RESPONSE_REQUIRED.',
  })
  @ApiResponse({
    status: 409,
    description: 'This claim is no longer open for new messages.',
  })
  async addMessage(
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AddClaimMessageDto,
  ) {
    return this.claimsService.addMessage(id, this.buildActor(seller), dto.body);
  }

  @Post('claims/:id/evidence')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      'Attaches evidence metadata to one of the claims the store is a party to (metadata only -- no file upload in this stage).',
  })
  @ApiResponse({
    status: 409,
    description: 'This claim is no longer open for new evidence.',
  })
  async addEvidence(
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AddClaimEvidenceDto,
  ) {
    return this.claimsService.addEvidence(id, this.buildActor(seller), dto);
  }

  @Post('claims/:id/dispute')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      'Escalates one of the claims the store is a party to into a Dispute.',
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
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.disputesService.openFromClaim(this.buildActor(seller), id);
  }

  @Post('returns/:id/dispute')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      'Escalates one of the returns the store is a party to into a Dispute.',
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
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.disputesService.openFromReturn(this.buildActor(seller), id);
  }

  @Get('disputes/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      "Fetches a dispute the authenticated store is a party to (originated from either the store's own Claim or Return).",
  })
  @ApiResponse({
    status: 404,
    description:
      "Dispute does not exist, or its originating Claim/Return does not belong to this store (never distinguished from the caller's perspective).",
  })
  async getDispute(
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.disputesService.getForSeller(seller.sellerId, id);
  }
}
