import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../session/session.types';
import type { AppPermission } from './authorization.types';
import { REQUIRED_ANY_PERMISSION } from './require-any-permission.decorator';
import { REQUIRED_PERMISSIONS } from './require-permissions.decorator';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const required = this.reflector.getAllAndOverride<AppPermission[]>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );
    const requiredAny = this.reflector.getAllAndOverride<AppPermission[]>(
      REQUIRED_ANY_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    const hasAll =
      !required?.length ||
      required.every((permission) =>
        request.principal.user.permissions.includes(permission),
      );
    const hasAny =
      !requiredAny?.length ||
      requiredAny.some((permission) =>
        request.principal.user.permissions.includes(permission),
      );
    const auditOnly =
      required?.length &&
      required.every((permission) => permission.startsWith('AUDIT_'));
    if (
      request.principal.nextStep !== 'APPLICATION' ||
      (!auditOnly &&
        (!request.principal.context.branch ||
          !request.principal.context.warehouse)) ||
      !hasAll ||
      !hasAny
    ) {
      const evaluated = [...(required ?? []), ...(requiredAny ?? [])];
      const inventory = evaluated.some((permission) =>
        permission.startsWith('INVENTORY_'),
      );
      const audit = evaluated.some((permission) =>
        permission.startsWith('AUDIT_'),
      );
      throw new ForbiddenException({
        code: audit
          ? 'AUDIT_ACCESS_DENIED'
          : inventory
            ? 'INVENTORY_ACCESS_DENIED'
            : 'PERMISSION_DENIED',
        message: 'No tienes permisos para realizar esta operación.',
      });
    }
    return true;
  }
}
