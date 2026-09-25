import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { Roles } from '../../common/decorators/roles.decorator';
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
  list(@Query() query: PaginationQueryDto) {
    return this.ordersService.listForAdmin(query);
  }
}
