/**
 * Plain TS mirrors of sellers-service's Prisma enums `SellerMembershipRole`
 * and `SellerStatus`. orders-service does not own the `Seller` /
 * `SellerMembership` models — they live in the `sellers` schema, a separate
 * service and database boundary — so these cannot come from this service's
 * own Prisma client. Same pattern already used here for identity-service's
 * enums (identity-enums.ts), and by catalog-service for this exact pair.
 *
 * Keep these values in sync with sellers-service's prisma/schema.prisma by
 * hand — a mismatch would silently misclassify what
 * SellersServiceClient.getMembershipByUserId returns.
 */
export enum SellerMembershipRole {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  STAFF = 'STAFF',
}

export enum SellerStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  REJECTED = 'REJECTED',
}
