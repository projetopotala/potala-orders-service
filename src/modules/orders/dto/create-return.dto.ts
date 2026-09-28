import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  MAX_RETURN_DESCRIPTION_LENGTH,
  MAX_RETURN_REASON_LENGTH,
} from '../../../common/constants/orders.constants';

/** Same trim helper as create-review.dto.ts / create-checkout.dto.ts. */
const TrimString = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class CreateReturnDto {
  @ApiProperty({ maxLength: MAX_RETURN_REASON_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_RETURN_REASON_LENGTH)
  reason!: string;

  @ApiPropertyOptional({ maxLength: MAX_RETURN_DESCRIPTION_LENGTH })
  @IsOptional()
  @TrimString()
  @IsString()
  @MaxLength(MAX_RETURN_DESCRIPTION_LENGTH)
  description?: string;
}
