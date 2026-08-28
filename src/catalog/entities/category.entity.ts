import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'categories' })
export class CategoryEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'tenant_id', type: 'char', length: 36 })
  tenantId!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ name: 'normalized_name', type: 'varchar', length: 80 })
  normalizedName!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}
