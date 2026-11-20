import { Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermission } from '../../common/permissions/require-permission.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { Role } from '../../common/types/identity-enums';

/**
 * Read-only admin view of SellerOrder rows across every store, marketplace-
 * wide -- new this session, backs the admin Financeiro screen (ver
 * status-migracao-microservicos.md, "Financeiro do vendedor"/admin).
 * Nenhum @UseGuards explícito aqui: SessionAuthGuard e RolesGuard são
 * APP_GUARD globais (app.module.ts) e leem o @Roles abaixo -- mesmo padrão
 * de AdminController em potala-sellers-service
 * (modules/admin/admin.controller.ts).
 */
@ApiTags('admin-orders')
@ApiBearerAuth()
@Controller('admin/orders')
@Roles(Role.ADMIN)
export class AdminOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lists SellerOrder rows across every store, newest first (marketplace-wide, admin only).',
  })
  @RequirePermission('orders:order:read', { mode: 'COLLECTION' })
  list(@Query() query: PaginationQueryDto) {
    return this.ordersService.listForAdmin(query);
  }

  /**
   * Operações administrativas de fulfillment seguem a mesma máquina de
   * estados do vendedor, mas ficam auditadas como ADMIN. A confirmação de
   * pagamento nunca passa por esta rota: PENDING -> CONFIRMED é exclusiva
   * do fluxo de pagamento aprovado.
   */
  @Patch(':id/prepare')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Admin: CONFIRMED -> PREPARING.' })
  @ApiResponse({ status: 409, description: 'The seller order is not CONFIRMED.' })
  @RequirePermission('orders:shipment:update', { mode: 'SELLER_OWNED' })
  prepare(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.ordersService.prepareForAdmin(id, user.id);
  }

  @Patch(':id/ship')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Admin: PREPARING -> SHIPPED.' })
  @ApiResponse({ status: 409, description: 'The seller order is not PREPARING.' })
  @RequirePermission('orders:shipment:update', { mode: 'SELLER_OWNED' })
  ship(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.ordersService.shipForAdmin(id, user.id);
  }

  @Patch(':id/deliver')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Admin: SHIPPED -> DELIVERED.' })
  @ApiResponse({ status: 409, description: 'The seller order is not SHIPPED.' })
  @RequirePermission('orders:shipment:update', { mode: 'SELLER_OWNED' })
  deliver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.ordersService.deliverForAdmin(id, user.id);
  }
}
