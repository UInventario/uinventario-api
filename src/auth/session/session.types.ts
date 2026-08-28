import { Request } from 'express';
import type { AppPermission } from '../authorization/authorization.types';

export interface SessionIdentity {
  sessionId: string;
  expiresAt: Date;
  user: {
    id: string;
    email: string;
    roles: string[];
    permissions: AppPermission[];
  };
  tenant: { id: string; name: string };
  context: {
    branch: { id: string; name: string } | null;
    warehouse: { id: string; name: string } | null;
    cashRegister: { id: string; name: string; code: string } | null;
  };
  nextStep: 'ONBOARDING' | 'APPLICATION';
}

export interface SessionResponse {
  data: Omit<SessionIdentity, 'sessionId' | 'expiresAt'>;
  meta: { apiVersion: '1'; sessionExpiresAt: string };
}

export interface AuthenticatedRequest extends Request {
  requestId?: string;
  principal: SessionIdentity;
  sessionToken: string;
}
