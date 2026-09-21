import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SellerActiveGuard, SellerContextGuard } from './seller.guard';
import { SellersServiceClient } from '../../clients/sellers-service.client';
import { RequestWithAuth } from '../types/authenticated-user';
import { Role, UserStatus } from '../types/identity-enums';
import { SellerMembershipRole, SellerStatus } from '../types/sellers-enums';

function createContext(request: Partial<RequestWithAuth>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function createSellersClientMock() {
  return {
    getMembershipByUserId: jest.fn(),
  } as unknown as jest.Mocked<SellersServiceClient>;
}

describe('SellerContextGuard', () => {
  it('rejects an unauthenticated request, without calling sellers-service', async () => {
    const sellersClient = createSellersClientMock();
    const guard = new SellerContextGuard(sellersClient);

    await expect(
      guard.canActivate(createContext({})),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sellersClient.getMembershipByUserId).not.toHaveBeenCalled();
  });

  it('rejects a user with no seller membership', async () => {
    const sellersClient = createSellersClientMock();
    sellersClient.getMembershipByUserId.mockResolvedValue(null);
    const guard = new SellerContextGuard(sellersClient);

    await expect(
      guard.canActivate(
        createContext({
          authUser: {
            id: 'user-1',
            email: 'a@test.com',
            status: UserStatus.ACTIVE,
            roles: [Role.SELLER],
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('attaches sellerContext for a member with a store', async () => {
    const sellersClient = createSellersClientMock();
    sellersClient.getMembershipByUserId.mockResolvedValue({
      membershipId: 'membership-1',
      userId: 'user-1',
      sellerId: 'seller-1',
      membershipRole: SellerMembershipRole.OWNER,
      sellerStatus: SellerStatus.PENDING,
    });
    const guard = new SellerContextGuard(sellersClient);

    const request: Partial<RequestWithAuth> = {
      authUser: {
        id: 'user-1',
        email: 'a@test.com',
        status: UserStatus.ACTIVE,
        roles: [Role.SELLER],
      },
    };
    await guard.canActivate(createContext(request));

    expect(sellersClient.getMembershipByUserId).toHaveBeenCalledWith('user-1');
    expect(request.sellerContext).toEqual({
      membershipId: 'membership-1',
      userId: 'user-1',
      sellerId: 'seller-1',
      membershipRole: SellerMembershipRole.OWNER,
      sellerStatus: SellerStatus.PENDING,
    });
  });

  it('propagates ServiceUnavailableException when sellers-service is unreachable', async () => {
    const sellersClient = createSellersClientMock();
    sellersClient.getMembershipByUserId.mockRejectedValue(
      new ServiceUnavailableException('down'),
    );
    const guard = new SellerContextGuard(sellersClient);

    await expect(
      guard.canActivate(
        createContext({
          authUser: {
            id: 'user-1',
            email: 'a@test.com',
            status: UserStatus.ACTIVE,
            roles: [Role.SELLER],
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('SellerActiveGuard', () => {
  it('rejects when sellerContext is missing', () => {
    const guard = new SellerActiveGuard();
    expect(() => guard.canActivate(createContext({}))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects a PENDING store', () => {
    const guard = new SellerActiveGuard();
    const request: Partial<RequestWithAuth> = {
      sellerContext: {
        membershipId: 'm1',
        userId: 'u1',
        sellerId: 's1',
        membershipRole: SellerMembershipRole.OWNER,
        sellerStatus: SellerStatus.PENDING,
      },
    };
    expect(() => guard.canActivate(createContext(request))).toThrow(
      ForbiddenException,
    );
  });

  it('allows an ACTIVE store', () => {
    const guard = new SellerActiveGuard();
    const request: Partial<RequestWithAuth> = {
      sellerContext: {
        membershipId: 'm1',
        userId: 'u1',
        sellerId: 's1',
        membershipRole: SellerMembershipRole.OWNER,
        sellerStatus: SellerStatus.ACTIVE,
      },
    };
    expect(guard.canActivate(createContext(request))).toBe(true);
  });
});
