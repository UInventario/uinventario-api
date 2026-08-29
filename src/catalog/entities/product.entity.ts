import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'products' })
export class ProductEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'tenant_id', type: 'char', length: 36 })
  tenantId!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Column({ type: 'varchar', length: 40 })
  sku!: string;

  @Column({ name: 'normalized_sku', type: 'varchar', length: 40 })
  normalizedSku!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  barcode!: string | null;

  @Column({ name: 'base_unit', type: 'varchar', length: 16, default: 'UNIT' })
  baseUnit!: string;

  @Column({
    name: 'quantity_precision',
    type: 'tinyint',
    unsigned: true,
    default: 3,
  })
  quantityPrecision!: number;

  @Column({
    name: 'quantity_rounding',
    type: 'varchar',
    length: 12,
    default: 'HALF_UP',
  })
  quantityRounding!: string;

  @Column({
    name: 'minimum_quantity',
    type: 'decimal',
    precision: 15,
    scale: 3,
    default: '0.001',
  })
  minimumQuantity!: string;

  @Column({ name: 'category_id', type: 'char', length: 36, nullable: true })
  categoryId!: string | null;

  @Column({ name: 'brand_id', type: 'char', length: 36, nullable: true })
  brandId!: string | null;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  cost!: string;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  price!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'int', unsigned: true, default: 1 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}
