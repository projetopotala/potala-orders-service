import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  MAX_REVIEW_COMMENT_LENGTH,
  MAX_REVIEW_RATING,
  MIN_REVIEW_RATING,
} from '../../../common/constants/orders.constants';

/** Trims before IsString/MaxLength so whitespace-only input is rejected, not stored. Same helper as create-checkout.dto.ts. */
const TrimString = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class CreateReviewDto {
  @ApiProperty({ minimum: MIN_REVIEW_RATING, maximum: MAX_REVIEW_RATING })
  @Type(() => Number)
  @IsInt()
  @Min(MIN_REVIEW_RATING)
  @Max(MAX_REVIEW_RATING)
  rating!: number;

  @ApiProperty({ required: false, maxLength: MAX_REVIEW_COMMENT_LENGTH })
  @IsOptional()
  @TrimString()
  @IsString()
  @MaxLength(MAX_REVIEW_COMMENT_LENGTH)
  comment?: string;
}
