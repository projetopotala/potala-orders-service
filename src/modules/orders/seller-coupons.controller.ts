import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CouponsService } from './coupons.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/identity-enums';

/**
 * Read-only, sem SellerContextGuard/SellerActiveGuard de propósito: cupom
 * é marketplace-wide (sem sellerId -- ver comentário no model Coupon em
 * schema.prisma), então não há nada pra escopar por loja aqui, e qualquer
 * usuário com Role.SELLER pode ver as promoções vigentes mesmo antes de
 * `SellerActiveGuard` liberar (mesmo raciocínio de permissividade já usado
 * em SellerSettingsController, sellers-service). Backs
 * SellerCouponsView.tsx (mock já dizia "visão demonstrativa... criação
 * avançada permanece no admin" -- esta rota só troca o mock por dado real,
 * sem mudar o escopo).
 */
@ApiTags('seller-coupons')
@ApiBearerAuth()
@Controller('seller/coupons')
@Roles(Role.SELLER)
export class SellerCouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Get()
  @ApiOperation({ summary: 'Lists currently active, marketplace-wide coupons (read-only).' })
  listActive() {
    return this.couponsService.listActive();
  }
}
