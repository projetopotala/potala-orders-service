import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * v1 only ever filters by productId (see roadmap-mercado-livre.md, seção
 * 6) — required, not optional: an unfiltered "all reviews in the system"
 * listing was never asked for and has no obvious ordering/UI use yet.
 */
export class PublicReviewsQueryDto extends PaginationQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Only reviews for this product.' })
  @IsUUID('4')
  productId!: string;
}
