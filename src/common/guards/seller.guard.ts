import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { SellersServiceClient } from '../../clients/sellers-service.client';
import { SellerStatus } from '../types/sellers-enums';
import { RequestWithAuth } from '../types/authenticated-user';

/**
 * Ported from catalog-service's own seller.guard.ts. This service has no
 * `membros_vendedor` table of its own, so it resolves the caller's store
 * membership by calling sellers-service's GET
 * /internal/sellers/membership/:userId via SellersServiceClient instead of a
 * local Prisma query. Same request.sellerContext shape, same 403 on a
 * missing membership.
 */
@Injectable()
export class SellerContextGuard implements CanActivate {
  constructor(private readonly sellersServiceClient: SellersServiceClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const user = request.authUser;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const membership = await this.sellersServiceClient.getMembershipByUserId(
      user.id,
    );

    if (!membership) {
      throw new ForbiddenException('Seller membership not found');
    }

    request.sellerContext = membership;
    return true;
  }
}

/** Ported unchanged from catalog-service: no network/DB dependency of its own. */
@Injectable()
export class SellerActiveGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const seller = request.sellerContext;

    if (!seller) {
      throw new ForbiddenException('Seller context is required');
    }

    if (seller.sellerStatus !== SellerStatus.ACTIVE) {
      throw new ForbiddenException(
        'Seller store is not active. Operational actions are blocked.',
      );
    }

    return true;
  }
}
