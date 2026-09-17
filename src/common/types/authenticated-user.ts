import { Request } from 'express';
import { Role, UserStatus } from './identity-enums';

/** Shape returned by identity-service's /internal/sessions/introspect. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  status: UserStatus;
  roles: Role[];
}

export interface RequestWithAuth extends Request {
  authUser?: AuthenticatedUser;
}
