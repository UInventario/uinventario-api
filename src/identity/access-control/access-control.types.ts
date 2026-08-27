import type { AppPermission } from '../../auth/authorization/authorization.types';

export interface AccessRoleData {
  id: string;
  name: string;
  permissions: AppPermission[];
}

export interface AccessUserData {
  id: string;
  email: string;
  roles: AccessRoleData[];
  branches: Array<{ id: string; name: string }>;
  manageable: boolean;
}
