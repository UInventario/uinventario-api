import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'tenants' })
export class TenantEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @Column({
    name: 'onboarding_completed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  onboardingCompletedAt!: Date | null;
}
