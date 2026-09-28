import { ApiPropertyOptional } from '@nestjs/swagger';
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

const TrimString = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * PATCH /admin/coupons/:id — every field optional, same hand-written style
 * as sellers-service's UpdateSellerSettingsDto (no @nestjs/mapped-types
 * anywhere in this project). discountType/discountValue must be sent
 * together when either changes -- CouponsService.update validates the pair
 * against whichever value (new or existing) ends up in effect, same
 * reasoning as the DB CHECK it mirrors.
 */
export class UpdateCouponDto {
  @ApiPropertyOptional({ maxLength: MAX_COUPON_CODE_LENGTH })
  @IsOptional()
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
  code?: string;

  @ApiPropertyOptional({ maxLength: MAX_COUPON_NAME_LENGTH })
  @IsOptional()
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COUPON_NAME_LENGTH)
  name?: string;

  @ApiPropertyOptional({ enum: CouponDiscountType })
  @IsOptional()
  @IsEnum(CouponDiscountType)
  discountType?: CouponDiscountType;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_COUPON_FIXED_DISCOUNT_CENTS)
  discountValue?: number;

  @ApiPropertyOptional({ description: 'ISO 8601.' })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional({ description: 'ISO 8601.' })
  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
