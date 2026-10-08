import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { ReturnsService } from './returns.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentSeller } from '../../common/decorators/current-seller.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  SellerActiveGuard,
  SellerContextGuard,
} from '../../common/guards/seller.guard';
import { Role } from '../../common/types/identity-enums';
import { SellerContext } from '../../common/types/authenticated-user';

/**
 * Leituras do SELLER sobre Return (nova rodada -- "Complementação das
 * APIs de Pós-venda"). SellerContextGuard/SellerActiveGuard resolvem
 * sellerId sobre a rede (sellers-service), mesmo padrão de
 * SellerOrdersController/SellerClaimsController.
 *
 * SOMENTE LEITURA: não existe aqui, de propósito, nenhuma operação de
 * aprovação/rejeição de Return para o SELLER -- essa decisão continua
 * exclusivamente com ADMIN (ver AdminReturnsController/
 * ReturnsService.decide), inalterada por esta rodada.
 *
 * Controller dedicado (em vez de anexar estas rotas a
 * SellerClaimsController, que já possui 'returns/:id/dispute') -- mesmo
 * raciocínio de "um controller por recurso" já usado em
 * SellerOrdersController/SellerReviewsController/SellerCouponsController,
 * e mantém a rota de abertura de disputa (POST returns/:id/dispute)
 * completamente intocada em seu controller original.
 *
 * Prefixo 'seller/returns' é um literal próprio, sem colisão de forma
 * com nenhuma outra rota 'seller/*' já registrada (mesmo raciocínio já
 * documentado em SellerClaimsController) -- a ordem de registro no
 * módulo é irrelevante para este controller.
 */
@ApiTags('seller-returns')
@ApiBearerAuth()
@Controller('seller/returns')
@Roles(Role.SELLER)
@UseGuards(SellerContextGuard, SellerActiveGuard)
export class SellerReturnsController {
  constructor(private readonly returnsService: ReturnsService) {}

  @Get()
  @ApiOperation({
    summary: "Lists the authenticated store's own returns, newest first.",
  })
  list(
    @CurrentSeller() seller: SellerContext,
    @Query() query: PaginationQueryDto,
  ) {
    return this.returnsService.listForSeller(seller.sellerId, query);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      "Fetches one of the authenticated store's own returns, including the linked dispute summary when one exists.",
  })
  @ApiResponse({
    status: 404,
    description:
      "Return does not exist, or belongs to a different store (never distinguished from the caller's perspective).",
  })
  getOne(
    @CurrentSeller() seller: SellerContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.returnsService.getForSeller(seller.sellerId, id);
  }
}
