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
