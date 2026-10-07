import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Min, MaxLength } from 'class-validator';
import {
  MAX_CLAIM_EVIDENCE_FILE_NAME_LENGTH,
  MAX_CLAIM_EVIDENCE_MIME_TYPE_LENGTH,
  MAX_CLAIM_EVIDENCE_STORAGE_KEY_LENGTH,
} from '../../../common/constants/orders.constants';

/** Same trim helper as the rest of this module's DTOs. */
const TrimString = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * Metadata only -- there is no real upload in this foundation stage (see
 * the ClaimEvidence model comment in schema.prisma: Supabase Storage
 * integration is explicitly NOT implemented yet). storageKey is whatever
 * key the (future) upload step already produced; this DTO never carries
 * a signed URL or a file's bytes. uploadedByUserId/uploadedByRole are not
 * part of this DTO for the same reason authorUserId/authorRole are not
 * part of AddClaimMessageDto -- resolved from the authenticated request
 * context, never trusted from the body.
 */
export class AddClaimEvidenceDto {
  @ApiProperty({ maxLength: MAX_CLAIM_EVIDENCE_STORAGE_KEY_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_CLAIM_EVIDENCE_STORAGE_KEY_LENGTH)
  storageKey!: string;

  @ApiProperty({ maxLength: MAX_CLAIM_EVIDENCE_FILE_NAME_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_CLAIM_EVIDENCE_FILE_NAME_LENGTH)
  fileName!: string;

  @ApiProperty({ maxLength: MAX_CLAIM_EVIDENCE_MIME_TYPE_LENGTH })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_CLAIM_EVIDENCE_MIME_TYPE_LENGTH)
  mimeType!: string;

  /** Mirrors the hand-added `sizeBytes > 0` CHECK in the migration -- see migration.sql. */
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}
