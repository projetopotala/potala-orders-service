import { Request } from 'express';
import { Role, UserStatus } from './identity-enums';
import { SellerMembershipRole, SellerStatus } from './sellers-enums';

/** Shape returned by identity-service's /internal/sessions/introspect. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  status: UserStatus;
  roles: Role[];
  /**
   * F1.3 -- campos acrescentados à introspecção pelo identity-service (F1.1 e
   * F1.2). Opcionais: a produção ainda pode responder o contrato antigo. São
   * lidos SÓ pelo avaliador em modo sombra (common/permissions), que valida
   * a forma antes de usar; nenhuma regra de acesso atual depende deles.
   */
  isSuperAdmin?: boolean;
  grants?: unknown;
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
