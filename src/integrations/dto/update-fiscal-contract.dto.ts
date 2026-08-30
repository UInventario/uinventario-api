import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { FISCAL_DOCUMENT_TYPES } from '../fiscal-contract.types';

const referencePattern = /^[A-Za-z][A-Za-z0-9_-]{2,159}$/;

export class UpdateFiscalContractDto {
  @IsIn(['1'])
  contractVersion!: '1';

  @IsIn(['SIMULATOR', 'LIVE_GENERIC'])
  providerProfile!: 'SIMULATOR' | 'LIVE_GENERIC';

  @IsBoolean()
  enabled!: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsIn(FISCAL_DOCUMENT_TYPES, { each: true })
  documentTypes!: Array<(typeof FISCAL_DOCUMENT_TYPES)[number]>;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  taxCodes!: string[];

  @IsIn(['PROVIDER', 'LOCAL_AUTHORIZED'])
  folioMode!: 'PROVIDER' | 'LOCAL_AUTHORIZED';

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @IsString()
  @MaxLength(32)
  taxIdentifier?: string | null;

  @IsOptional()
  @Matches(referencePattern)
  certificateSecretReference?: string | null;

  @IsOptional()
  @Matches(referencePattern)
  privateKeySecretReference?: string | null;

  @IsOptional()
  @Matches(referencePattern)
  folioAuthorizationSecretReference?: string | null;

  @IsOptional()
  @IsIn(['TEST', 'PRODUCTION'])
  environment?: 'TEST' | 'PRODUCTION' | null;
}
