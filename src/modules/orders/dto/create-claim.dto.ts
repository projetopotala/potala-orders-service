import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  MAX_CLAIM_DESCRIPTION_LENGTH,
  MAX_CLAIM_REASON_LENGTH,
} from '../../../common/constants/orders.constants';

/** Same trim helper as create-return.dto.ts / create-review.dto.ts. */
const TrimString = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class CreateClaimDto {
  @ApiProperty({ maxLength: MAX_CLAIM_REASON_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_CLAIM_REASON_LENGTH)
  reason!: string;

  @ApiPropertyOptional({ maxLength: MAX_CLAIM_DESCRIPTION_LENGTH })
  @IsOptional()
  @TrimString()
  @IsString()
  @MaxLength(MAX_CLAIM_DESCRIPTION_LENGTH)
  description?: string;
}
