import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import {
  buildPage,
  prismaIdCursorArgs,
  requireCursor,
  resolvePagination,
} from './pagination';
import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
} from './pagination.constants';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';

describe('resolvePagination', () => {
  it('defaults limit to 20', () => {
    expect(resolvePagination({})).toEqual({
      limit: PAGINATION_DEFAULT_LIMIT,
      cursor: undefined,
    });
  });

  it('accepts the maximum limit of 100', () => {
    expect(resolvePagination({ limit: PAGINATION_MAX_LIMIT })).toEqual({
      limit: 100,
      cursor: undefined,
    });
  });

  it('rejects limit above 100', () => {
    expect(() => resolvePagination({ limit: 101 })).toThrow(
      BadRequestException,
    );
  });

  it('rejects limit below 1', () => {
    expect(() => resolvePagination({ limit: 0 })).toThrow(BadRequestException);
  });
});

describe('buildPage', () => {
  it('marks hasNextPage when Prisma returned the extra probe row', () => {
    const rows = [
      { id: ID_A },
      { id: ID_B },
      { id: '00000000-0000-4000-8000-00000000000c' },
    ];
    const page = buildPage(rows, 2);

    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.id)).toEqual([ID_A, ID_B]);
    expect(page.pageInfo).toEqual({
      hasNextPage: true,
      nextCursor: ID_B,
    });
  });

  it('sets nextCursor to null on the last page', () => {
    const page = buildPage([{ id: ID_A }], 20);

    expect(page.items).toHaveLength(1);
    expect(page.pageInfo).toEqual({
      hasNextPage: false,
      nextCursor: null,
    });
  });
});

describe('prismaIdCursorArgs', () => {
  it('requests limit + 1 without a cursor on the first page', () => {
    expect(prismaIdCursorArgs(20)).toEqual({ take: 21 });
  });

  it('skips the cursor row on the next page', () => {
    expect(prismaIdCursorArgs(20, ID_A)).toEqual({
      take: 21,
      skip: 1,
      cursor: { id: ID_A },
    });
  });
});

describe('requireCursor', () => {
  it('rejects an unknown or unauthorized cursor', async () => {
    await expect(requireCursor(ID_A, async () => false)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('skips lookup when cursor is omitted', async () => {
    const exists = jest.fn();
    await requireCursor(undefined, exists);
    expect(exists).not.toHaveBeenCalled();
  });
});

describe('PaginationQueryDto', () => {
  async function validateQuery(plain: Record<string, unknown>) {
    const dto = plainToInstance(PaginationQueryDto, plain);
    return validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  }

  it('accepts an omitted limit (service default applies)', async () => {
    expect(await validateQuery({})).toHaveLength(0);
  });

  it('accepts limit 100', async () => {
    expect(await validateQuery({ limit: 100 })).toHaveLength(0);
  });

  it('rejects limit above 100', async () => {
    const errors = await validateQuery({ limit: 101 });
    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('rejects a non-uuid cursor', async () => {
    const errors = await validateQuery({ cursor: 'not-a-uuid' });
    expect(errors.some((error) => error.property === 'cursor')).toBe(true);
  });

  it('rejects unknown query fields such as sellerId', async () => {
    const errors = await validateQuery({ sellerId: ID_A, limit: 20 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('coerces query-string limit to a number', async () => {
    const dto = plainToInstance(PaginationQueryDto, { limit: '20' });
    expect(dto.limit).toBe(20);
    expect(await validate(dto)).toHaveLength(0);
  });
});
