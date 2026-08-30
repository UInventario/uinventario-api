import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { ERP_RESOURCES } from '../erp-integration.types';

export class ErpMappingRecordDto {
  @IsIn(ERP_RESOURCES)
  resource!: (typeof ERP_RESOURCES)[number];

  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,99}$/)
  externalId!: string;

  @IsUUID()
  internalId!: string;
}

export class ImportErpMappingsDto {
  @Matches(/^[A-Z][A-Z0-9_-]{1,31}$/)
  provider!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ErpMappingRecordDto)
  records!: ErpMappingRecordDto[];
}
