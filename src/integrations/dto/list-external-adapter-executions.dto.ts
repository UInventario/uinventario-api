import { IsIn, IsOptional } from 'class-validator';
import type { ExternalAdapterStatus } from '../external-adapter.types';

export class ListExternalAdapterExecutionsDto {
  @IsOptional()
  @IsIn(['PENDING', 'SUCCEEDED', 'REJECTED', 'RETRYABLE_FAILURE', 'TIMED_OUT'])
  status?: ExternalAdapterStatus;
}
