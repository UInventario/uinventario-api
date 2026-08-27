import { Request } from 'express';

export interface SessionIdentity {
  sessionId: string;
  expiresAt: Date;
  user: { id: string; email: string; roles: string[] };
  tenant: { id: string; name: string };
  nextStep: 'ONBOARDING' | 'APPLICATION';
}

export interface SessionResponse {
  data: Omit<SessionIdentity, 'sessionId' | 'expiresAt'>;
  meta: { apiVersion: '1'; sessionExpiresAt: string };
}

export interface AuthenticatedRequest extends Request {
  principal: SessionIdentity;
  sessionToken: string;
}
