import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestWithAuth, SellerContext } from '../types/authenticated-user';

export const CurrentSeller = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SellerContext => {
    const request = ctx.switchToHttp().getRequest<RequestWithAuth>();
    if (!request.sellerContext) {
      throw new Error('CurrentSeller used without seller context');
    }
    return request.sellerContext;
  },
);
