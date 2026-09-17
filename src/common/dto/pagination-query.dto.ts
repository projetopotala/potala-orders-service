import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  PAGINATION_MIN_LIMIT,
} from '../pagination/pagination.constants';

export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Page size',
    default: PAGINATION_DEFAULT_LIMIT,
    minimum: PAGINATION_MIN_LIMIT,
    maximum: PAGINATION_MAX_LIMIT,
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PAGINATION_MIN_LIMIT)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number;

  @ApiPropertyOptional({
    description: 'UUID of the last item from the previous page',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID('4')
  cursor?: string;
}
