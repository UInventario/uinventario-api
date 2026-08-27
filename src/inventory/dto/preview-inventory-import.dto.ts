import { IsIn } from 'class-validator';

export const INVENTORY_IMPORT_MODES = ['INITIAL', 'COUNT'] as const;
export type InventoryImportMode = (typeof INVENTORY_IMPORT_MODES)[number];

export class PreviewInventoryImportDto {
  @IsIn(INVENTORY_IMPORT_MODES)
  mode!: InventoryImportMode;
}
