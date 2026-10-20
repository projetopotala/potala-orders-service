import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { DisputesService } from './disputes.service';
import { RecordDisputeDecisionDto } from './dto/record-dispute-decision.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermission } from '../../common/permissions/require-permission.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { Role } from '../../common/types/identity-enums';
import { PostSaleActor } from '../../common/types/post-sale-actor';

/**
 * Pós-venda do ADMIN -- Disputes. Prefixo 'admin/disputes' é literal
 * próprio, sem colisão com 'admin/claims'/'admin/orders'/
 * 'admin/returns'/'admin/coupons' -- SessionAuthGuard/RolesGuard já são
 * APP_GUARD globais. PostSaleActor é montado SOMENTE a partir de
 * @CurrentUser() como { role: Role.ADMIN, userId: user.id };
 * decidedByUserId nunca vem do corpo -- DisputesService.recordDecision
 * resolve isso a partir do actor (ver RecordDisputeDecisionDto, que não
 * tem esse campo).
 */
@ApiTags('admin-disputes')
@ApiBearerAuth()
@Controller('admin/disputes')
@Roles(Role.ADMIN)
export class AdminDisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  private buildActor(user: AuthenticatedUser): PostSaleActor {
    return { role: Role.ADMIN, userId: user.id };
  }

  @Get()
  @ApiOperation({
    summary: 'Lists every dispute, across every store, newest first.',
  })
  @RequirePermission('aftersales:dispute:read', { mode: 'COLLECTION' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.disputesService.listForAdmin(this.buildActor(user), query);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Fetches one dispute.' })
  @ApiResponse({ status: 404, description: 'Dispute does not exist.' })
  @RequirePermission('aftersales:dispute:read', { mode: 'SELLER_OWNED' })
  async getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.disputesService.getForAdmin(this.buildActor(user), id);
  }

  @Post(':id/decisions')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Records the admin decision for a dispute.' })
  @ApiResponse({ status: 201, description: 'Decision recorded.' })
  @ApiResponse({
    status: 409,
    description:
      'This dispute has already been decided and can no longer receive a new decision.',
  })
  @RequirePermission('aftersales:dispute:update', { mode: 'SELLER_OWNED' })
  async recordDecision(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RecordDisputeDecisionDto,
  ) {
    return this.disputesService.recordDecision(id, this.buildActor(user), dto);
  }
}
