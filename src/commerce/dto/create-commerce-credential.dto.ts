import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  COMMERCE_SCOPES,
  COMMERCE_WEBHOOK_EVENTS,
  type CommerceScope,
  type CommerceWebhookEvent,
} from '../commerce.types';

export class CreateCommerceCredentialDto {
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(COMMERCE_SCOPES, { each: true })
  scopes!: CommerceScope[];

  @IsUUID()
  branchId!: string;

  @IsUUID()
  warehouseId!: string;

  @IsUUID()
  cashRegisterId!: string;

  @IsUUID()
  locationId!: string;

  @IsUUID()
  customerId!: string;

  @IsInt()
  @Min(10)
  @Max(600)
  rateLimitPerMinute!: number;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  webhookUrl?: string;

  @IsArray()
  @ArrayUnique()
  @IsIn(COMMERCE_WEBHOOK_EVENTS, { each: true })
  webhookEvents!: CommerceWebhookEvent[];

  @IsBoolean()
  webhookEnabled!: boolean;
}
