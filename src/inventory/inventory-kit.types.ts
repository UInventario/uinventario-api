export interface InventoryKitOperationData {
  id: string;
  operationType: 'ASSEMBLE' | 'DISASSEMBLE';
  kit: { id: string; name: string; sku: string };
  locationId: string;
  quantity: string;
  components: Array<{
    product: { id: string; name: string; sku: string };
    quantityChange: string;
  }>;
  createdAt: string;
}
