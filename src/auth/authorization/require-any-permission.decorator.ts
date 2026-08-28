import { SetMetadata } from '@nestjs/common';
import type { AppPermission } from './authorization.types';

export const REQUIRED_ANY_PERMISSION = 'required_any_permission';

export const RequireAnyPermission = (...permissions: AppPermission[]) =>
  SetMetadata(REQUIRED_ANY_PERMISSION, permissions);
