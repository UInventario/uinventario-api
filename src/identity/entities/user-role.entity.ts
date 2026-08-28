import { Entity, PrimaryColumn } from 'typeorm';
import { Column } from 'typeorm';

@Entity({ name: 'user_roles' })
export class UserRoleEntity {
  @PrimaryColumn({ name: 'user_id', type: 'char', length: 36 })
  userId!: string;

  @PrimaryColumn({ name: 'role_id', type: 'char', length: 36 })
  roleId!: string;

  @Column({ name: 'tenant_id', type: 'char', length: 36 })
  tenantId!: string;
}
