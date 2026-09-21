import { Request } from 'express';
import { Role, UserStatus } from './identity-enums';
import { SellerMembershipRole, SellerStatus } from './sellers-enums';

/** Shape returned by identity-service's /internal/sessions/introspect. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  status: UserStatus;
  roles: Role[];
}

/**
 * Shape returned by sellers-service's
 * GET /internal/sellers/membership/:userId — the network equivalent of the
 * SellerContext sellers-service builds locally from its own database.
 */
export interface SellerContext {
  membershipId: string;
  userId: string;
  sellerId: string;
  membershipRole: SellerMembershipRole;
  sellerStatus: SellerStatus;
}

export interface RequestWithAuth extends Request {
  authUser?: AuthenticatedUser;
  sellerContext?: SellerContext;
}
