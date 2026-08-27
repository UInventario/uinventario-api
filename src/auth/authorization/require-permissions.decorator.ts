import { SetMetadata } from '@nestjs/common';
import type { AppPermission } from './authorization.types';

export const REQUIRED_PERMISSIONS = 'required_permissions';

export const RequirePermissions = (...permissions: AppPermission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
