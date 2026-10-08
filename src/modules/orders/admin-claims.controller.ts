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
import { AddClaimMessageDto } from './dto/add-claim-message.dto';
import { AddClaimEvidenceDto } from './dto/add-claim-evidence.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { Role } from '../../common/types/identity-enums';
import { PostSaleActor } from '../../common/types/post-sale-actor';

/**
 * Pós-venda do ADMIN -- Claims. SessionAuthGuard/RolesGuard já são
 * APP_GUARD globais (nenhum @UseGuards explícito necessário, mesmo
 * padrão de AdminOrdersController/AdminReturnsController).
 * PostSaleActor é montado aqui SOMENTE a partir de @CurrentUser()
 * (request.authUser) como { role: Role.ADMIN, userId: user.id } --
 * ClaimsService/DisputesService seguem sendo a única autoridade de
 * domínio (listForAdmin/getForAdmin já exigem actor.role === ADMIN
 * internamente, em profundidade).
 *
 * DECISÃO: @Controller() sem prefixo (em vez de @Controller('admin/claims'))
 * porque a rota "abrir disputa a partir de uma Return" pedida nesta
 * seção é POST /admin/returns/:id/dispute -- fora do prefixo
 * 'admin/claims'. Caminho completo em cada rota evita um segundo
 * controller só para essa única rota, e não toca em
 * AdminReturnsController (prefixo 'admin/returns') nem duplica nada
 * dele: AdminReturnsController continua dono exclusivo de
 * approve/reject de Return. POST /admin/returns/:id/dispute (método
 * POST, sufixo 'dispute') não colide em forma com nenhuma rota de
 * AdminReturnsController (GET '', PATCH ':id/approve', PATCH
 * ':id/reject') -- método e segmento final distintos.
 */
@ApiTags('admin-claims')
@ApiBearerAuth()
@Controller()
@Roles(Role.ADMIN)
export class AdminClaimsController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly disputesService: DisputesService,
  ) {}

  private buildActor(user: AuthenticatedUser): PostSaleActor {
    return { role: Role.ADMIN, userId: user.id };
  }

  @Get('admin/claims')
  @ApiOperation({
    summary: 'Lists every claim, across every store, newest first.',
  })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.claimsService.listForAdmin(this.buildActor(user), query);
  }

  @Get('admin/claims/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Fetches one claim, including messages and evidence.',
  })
  @ApiResponse({ status: 404, description: 'Claim does not exist.' })
  async getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.claimsService.getForAdmin(this.buildActor(user), id);
  }

  @Post('admin/claims/:id/messages')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Adds an admin message to a claim.' })
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

  @Post('admin/claims/:id/evidence')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      'Attaches evidence metadata to a claim (metadata only -- no file upload in this stage).',
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

  @Patch('admin/claims/:id/escalate')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Admin escalates a claim.' })
  @ApiResponse({
    status: 409,
    description: 'The claim cannot move to ESCALATED from its current status.',
  })
  async escalate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.claimsService.transitionStatus(
      id,
      this.buildActor(user),
      ClaimStatus.ESCALATED,
    );
  }

  @Patch('admin/claims/:id/resolve')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Admin marks a claim as resolved.' })
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

  @Patch('admin/claims/:id/close')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Admin closes a claim.' })
  @ApiResponse({
    status: 409,
    description: 'The claim cannot move to CLOSED from its current status.',
  })
  async close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.claimsService.transitionStatus(
      id,
      this.buildActor(user),
      ClaimStatus.CLOSED,
    );
  }

  @Post('admin/claims/:id/dispute')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Admin escalates a claim into a Dispute.' })
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

  @Post('admin/returns/:id/dispute')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Admin escalates a return into a Dispute.' })
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
}
