import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'tenants' })
export class TenantEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ name: 'legal_name', type: 'varchar', length: 160, nullable: true })
  legalName!: string | null;

  @Column({ name: 'country_code', type: 'char', length: 2, nullable: true })
  countryCode!: string | null;

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
