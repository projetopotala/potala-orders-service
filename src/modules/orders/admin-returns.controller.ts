import { Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ReturnStatus } from '@prisma/client';
import { ReturnsService } from './returns.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/identity-enums';

/**
 * O admin como mediador -- backs a tela de Devoluções do admin (ver
 * comentário no model Return, schema.prisma). Nenhum @UseGuards
 * explícito: mesmo padrão de AdminOrdersController/AdminCouponsController
 * acima, SessionAuthGuard/RolesGuard são APP_GUARD globais.
 */
@ApiTags('admin-returns')
@ApiBearerAuth()
@Controller('admin/returns')
@Roles(Role.ADMIN)
export class AdminReturnsController {
  constructor(private readonly returnsService: ReturnsService) {}

  @Get()
  @ApiOperation({ summary: 'Lists every return request, across every store, newest first.' })
  list(@Query() query: PaginationQueryDto) {
    return this.returnsService.listForAdmin(query);
  }

  @Patch(':id/approve')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      'Approves a return request. Does not process a refund or restock inventory -- see the Return model comment for why; handled outside the system for now.',
  })
  approve(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.returnsService.decide(id, ReturnStatus.APPROVED);
  }

  @Patch(':id/reject')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Rejects a return request.' })
  reject(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.returnsService.decide(id, ReturnStatus.REJECTED);
  }
}
