import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { DisputeOutcome } from '@prisma/client';
import { MAX_DISPUTE_DECISION_REASON_LENGTH } from '../../../common/constants/orders.constants';

/** Same trim helper as the rest of this module's DTOs. */
const TrimString = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * decidedByUserId is not part of this DTO -- same reasoning as every other
 * actor-identity field in this module: resolved from the authenticated
 * (admin) request context, never trusted from the body.
 */
export class RecordDisputeDecisionDto {
  @ApiProperty({ enum: DisputeOutcome })
  @IsEnum(DisputeOutcome)
  outcome!: DisputeOutcome;

  @ApiProperty({ maxLength: MAX_DISPUTE_DECISION_REASON_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_DISPUTE_DECISION_REASON_LENGTH)
  reason!: string;
}
