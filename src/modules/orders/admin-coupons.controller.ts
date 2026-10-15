import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CouponsService } from './coupons.service';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  PermissionPending,
  RequirePermission,
} from '../../common/permissions/require-permission.decorator';
import { Role } from '../../common/types/identity-enums';

/**
 * CRUD completo -- backs the admin "Cupons" screen (ver
 * status-migracao-microservicos.md). Nenhum @UseGuards explícito: mesmo
 * padrão de AdminOrdersController acima, SessionAuthGuard/RolesGuard são
 * APP_GUARD globais.
 *
 * Sem endpoint de "duplicar" -- no mock aquilo só pré-preenchia o modal de
 * criação no cliente (nunca chamava o backend); a tela nova faz a mesma
 * coisa client-side, reaproveitando POST abaixo.
 */
@ApiTags('admin-coupons')
@ApiBearerAuth()
@Controller('admin/coupons')
@Roles(Role.ADMIN)
export class AdminCouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Get()
  @ApiOperation({ summary: 'Lists every coupon, newest first.' })
  @RequirePermission('marketing:coupon:read', { mode: 'PLATFORM' })
  list(@Query() query: PaginationQueryDto) {
    return this.couponsService.list(query);
  }

  @Post()
  @ApiOperation({ summary: 'Creates a new coupon.' })
  @RequirePermission('marketing:coupon:create', { mode: 'PLATFORM' })
  create(@Body() dto: CreateCouponDto) {
    return this.couponsService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Updates one or more fields of an existing coupon.' })
  @RequirePermission('marketing:coupon:update', { mode: 'PLATFORM' })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCouponDto,
  ) {
    return this.couponsService.update(id, dto);
  }

  @Patch(':id/activate')
  @ApiOperation({ summary: 'Turns the coupon on (does not touch its validity window).' })
  @RequirePermission('marketing:coupon:update', { mode: 'PLATFORM' })
  activate(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.couponsService.setEnabled(id, true);
  }

  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Turns the coupon off (does not touch its validity window).' })
  @RequirePermission('marketing:coupon:deactivate', { mode: 'PLATFORM' })
  deactivate(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.couponsService.setEnabled(id, false);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Permanently deletes a coupon.' })
  @PermissionPending(
    'Exclusão física de cupom: o catálogo F1.2 não tem verbo de exclusão (R-8 prevê exclusão lógica); definir antes da F1.6',
  )
  remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.couponsService.remove(id);
  }
}
