import { IsUUID } from 'class-validator';

export class CreateFavoriteDto {
  @IsUUID('4')
  productId!: string;
}
