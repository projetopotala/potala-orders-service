import { BadRequestException } from '@nestjs/common';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  PAGINATION_MIN_LIMIT,
} from './pagination.constants';

export type PageInfo = {
  nextCursor: string | null;
  hasNextPage: boolean;
};

export type Paginated<T> = {
  items: T[];
  pageInfo: PageInfo;
};

export type ResolvedPagination = {
  limit: number;
  cursor?: string;
};

/** Stable newest-first order; `id` is the unique cursor field. */
export const PAGINATION_ORDER_CREATED_AT_ID_DESC = [
  { createdAt: 'desc' as const },
  { id: 'desc' as const },
];

export function resolvePagination(
  query: PaginationQueryDto = {},
): ResolvedPagination {
  const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
  if (
    !Number.isInteger(limit) ||
    limit < PAGINATION_MIN_LIMIT ||
    limit > PAGINATION_MAX_LIMIT
  ) {
    throw new BadRequestException(
      `limit must be an integer between ${PAGINATION_MIN_LIMIT} and ${PAGINATION_MAX_LIMIT}`,
    );
  }

  return { limit, cursor: query.cursor };
}

export function prismaIdCursorArgs(limit: number, cursor?: string) {
  return {
    take: limit + 1,
    ...(cursor ? { skip: 1 as const, cursor: { id: cursor } } : {}),
  };
}

/**
 * `rows` must come from Prisma `take: limit + 1`.
 * The extra row is only a hasNextPage probe — not an in-memory full-table slice.
 */
export function buildPage<T extends { id: string }>(
  rows: T[],
  limit: number,
): Paginated<T> {
  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const lastItem = items.at(-1);

  return {
    items,
    pageInfo: {
      hasNextPage,
      nextCursor: hasNextPage && lastItem ? lastItem.id : null,
    },
  };
}

export async function requireCursor(
  cursor: string | undefined,
  exists: (id: string) => Promise<boolean>,
): Promise<void> {
  if (!cursor) {
    return;
  }
  if (!(await exists(cursor))) {
    throw new BadRequestException('Invalid cursor');
  }
}
