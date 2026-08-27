import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'sessions' })
export class SessionEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash!: string;

  @Column({ name: 'user_id', type: 'char', length: 36 })
  userId!: string;

  @Column({ name: 'tenant_id', type: 'char', length: 36 })
  tenantId!: string;

  @Column({ name: 'expires_at', type: 'datetime', precision: 6 })
  expiresAt!: Date;

  @Column({
    name: 'revoked_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  revokedAt!: Date | null;

  @Column({
    name: 'active_branch_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  activeBranchId!: string | null;

  @Column({
    name: 'active_warehouse_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  activeWarehouseId!: string | null;

  @Column({
    name: 'active_cash_register_id',
    type: 'char',
    length: 36,
    nullable: true,
  })
  activeCashRegisterId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}
