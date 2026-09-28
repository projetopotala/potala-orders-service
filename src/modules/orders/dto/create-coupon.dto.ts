import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CouponDiscountType } from '@prisma/client';
import {
  MAX_COUPON_CODE_LENGTH,
  MAX_COUPON_FIXED_DISCOUNT_CENTS,
  MAX_COUPON_NAME_LENGTH,
  MIN_COUPON_CODE_LENGTH,
} from '../../../common/constants/orders.constants';

/** Same trim helper as create-checkout.dto.ts (catalog-service's create-product.dto.ts originated it). */
const TrimString = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class CreateCouponDto {
  @ApiProperty({
    maxLength: MAX_COUPON_CODE_LENGTH,
    description: 'Normalized to uppercase on save -- codes are case-insensitive at checkout.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(MIN_COUPON_CODE_LENGTH)
  @MaxLength(MAX_COUPON_CODE_LENGTH)
  @Matches(/^[A-Z0-9-]+$/, {
    message: 'code must contain only letters, digits and hyphens',
  })
  code!: string;

  @ApiProperty({ maxLength: MAX_COUPON_NAME_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COUPON_NAME_LENGTH)
  name!: string;

  @ApiProperty({ enum: CouponDiscountType })
  @IsEnum(CouponDiscountType)
  discountType!: CouponDiscountType;

  @ApiProperty({
    description:
      'PERCENT: 1-100. FIXED: cents, 1 up to MAX_COUPON_FIXED_DISCOUNT_CENTS -- which ceiling applies is validated in CouponsService against discountType (a DB CHECK also enforces the PERCENT <= 100 half).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_COUPON_FIXED_DISCOUNT_CENTS)
  discountValue!: number;

  @ApiProperty({ description: 'ISO 8601. Must be before endsAt.' })
  @IsDateString()
  startsAt!: string;

  @ApiProperty({ description: 'ISO 8601. Must be after startsAt.' })
  @IsDateString()
  endsAt!: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
