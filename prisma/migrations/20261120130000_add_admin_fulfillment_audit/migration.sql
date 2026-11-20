-- Admin fulfillment must never be indistinguishable from a seller action.
-- Additive only: no existing rows or tables are modified. Do not apply this
-- migration to a shared/production database without the release review.
ALTER TYPE "orders"."OrderStatusHistorySource" ADD VALUE IF NOT EXISTS 'ADMIN';
ALTER TYPE "orders"."OrderStatusHistoryActorType" ADD VALUE IF NOT EXISTS 'ADMIN';
