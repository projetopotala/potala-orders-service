/**
 * Plain TS mirrors of identity-service's Prisma enums `Role` and
 * `UserStatus`. orders-service does not own the `User` model — it lives in
 * the `identity` schema, a separate service and database boundary — so
 * these cannot come from this service's own Prisma client. Same pattern
 * sellers-service and catalog-service already use for the same reason.
 *
 * Keep these values in sync with identity-service's prisma/schema.prisma by
 * hand — a mismatch would silently misclassify roles/status coming back from
 * IdentityServiceClient.introspectSession.
 */
export enum Role {
  CUSTOMER = 'CUSTOMER',
  SELLER = 'SELLER',
  ADMIN = 'ADMIN',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  BLOCKED = 'BLOCKED',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
}
