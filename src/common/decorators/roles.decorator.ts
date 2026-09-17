import { SetMetadata } from '@nestjs/common';
import { ROLES_KEY } from '../constants/auth.constants';
import { Role } from '../types/identity-enums';

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
