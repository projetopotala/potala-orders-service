import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MAX_CHECKOUT_ITEMS,
  MAX_ITEM_QUANTITY,
  MAX_SHIPPING_COMPLEMENT_LENGTH,
  MAX_SHIPPING_FIELD_LENGTH,
  MAX_SHIPPING_POSTAL_CODE_LENGTH,
  MAX_SHIPPING_STATE_LENGTH,
  MIN_CHECKOUT_ITEMS,
  MIN_ITEM_QUANTITY,
} from '../../../common/constants/orders.constants';

/** Trims before IsNotEmpty/MaxLength so whitespace-only input is rejected, not stored. Same helper as catalog-service's create-product.dto.ts. */
const TrimString = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class CheckoutItemDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Must match the productId catalog-service resolves for variantId below — a mismatch is rejected, not silently corrected.',
  })
  @IsUUID('4')
  productId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  variantId!: string;

  @ApiProperty({ minimum: MIN_ITEM_QUANTITY, maximum: MAX_ITEM_QUANTITY })
  @Type(() => Number)
  @IsInt()
  @Min(MIN_ITEM_QUANTITY)
  @Max(MAX_ITEM_QUANTITY)
  quantity!: number;
}

export class ShippingAddressDto {
  @ApiProperty({ maxLength: MAX_SHIPPING_FIELD_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SHIPPING_FIELD_LENGTH)
  recipient!: string;

  @ApiProperty({ maxLength: MAX_SHIPPING_FIELD_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SHIPPING_FIELD_LENGTH)
  street!: string;

  @ApiProperty({ maxLength: MAX_SHIPPING_FIELD_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SHIPPING_FIELD_LENGTH)
  number!: string;

  @ApiProperty({ required: false, maxLength: MAX_SHIPPING_COMPLEMENT_LENGTH })
  @IsOptional()
  @TrimString()
  @IsString()
  @MaxLength(MAX_SHIPPING_COMPLEMENT_LENGTH)
  complement?: string;

  @ApiProperty({ maxLength: MAX_SHIPPING_FIELD_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SHIPPING_FIELD_LENGTH)
  neighborhood!: string;

  @ApiProperty({ maxLength: MAX_SHIPPING_FIELD_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SHIPPING_FIELD_LENGTH)
  city!: string;

  @ApiProperty({
    maxLength: MAX_SHIPPING_STATE_LENGTH,
    description: 'Two-letter Brazilian state code (e.g. SP, RJ).',
  })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SHIPPING_STATE_LENGTH)
  state!: string;

  @ApiProperty({ maxLength: MAX_SHIPPING_POSTAL_CODE_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SHIPPING_POSTAL_CODE_LENGTH)
  postalCode!: string;
}

export class CreateCheckoutDto {
  @ApiProperty({
    type: [CheckoutItemDto],
    minItems: MIN_CHECKOUT_ITEMS,
    maxItems: MAX_CHECKOUT_ITEMS,
  })
  @ArrayMinSize(MIN_CHECKOUT_ITEMS)
  @ArrayMaxSize(MAX_CHECKOUT_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];

  @ApiProperty({ type: ShippingAddressDto })
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress!: ShippingAddressDto;

  @ApiProperty({
    required: false,
    description:
      'Optional coupon code, validated against Coupon at checkout time (CouponsService.resolveForCheckout) -- invalid, disabled, scheduled or expired codes reject the whole checkout.',
  })
  @IsOptional()
  @TrimString()
  @IsString()
  @MaxLength(30)
  couponCode?: string;
}
