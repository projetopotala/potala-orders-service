import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MAX_CLAIM_MESSAGE_LENGTH } from '../../../common/constants/orders.constants';

/** Same trim helper as the rest of this module's DTOs. */
const TrimString = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * Body only -- author (userId/role) never comes from this DTO. It is
 * resolved from the authenticated request context by whichever controller
 * calls ClaimsService.addMessage, same reasoning as every other
 * actor-identity field in this project (e.g. OrdersController never trusts
 * a customerId in the request body either).
 */
export class AddClaimMessageDto {
  @ApiProperty({ maxLength: MAX_CLAIM_MESSAGE_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_CLAIM_MESSAGE_LENGTH)
  body!: string;
}
