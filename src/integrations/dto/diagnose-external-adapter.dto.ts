import { IsIn } from 'class-validator';
import type { ExternalAdapterScenario } from '../external-adapter.types';

export class DiagnoseExternalAdapterDto {
  @IsIn(['SUCCESS', 'REJECT', 'TIMEOUT', 'RETRY'])
  scenario!: ExternalAdapterScenario;
}
