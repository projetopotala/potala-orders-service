import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser, RequestWithAuth } from '../types/authenticated-user';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<RequestWithAuth>();
    if (!request.authUser) {
      throw new Error('CurrentUser used without authenticated request');
    }
    return request.authUser;
  },
);
