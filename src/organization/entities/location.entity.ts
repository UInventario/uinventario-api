import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'locations' })
export class LocationEntity {
  @PrimaryColumn({ type: 'char', length: 36 }) id!: string;
  @Column({ name: 'tenant_id', type: 'char', length: 36 }) tenantId!: string;
  @Column({ name: 'warehouse_id', type: 'char', length: 36 })
  warehouseId!: string;
  @Column({ type: 'varchar', length: 120 }) name!: string;
  @Column({ type: 'varchar', length: 40 }) code!: string;
  @Column({
    name: 'onboarding_key',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  onboardingKey!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}
