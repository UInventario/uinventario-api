import { Request } from 'express';

export interface SessionIdentity {
  sessionId: string;
  user: { id: string; email: string; roles: string[] };
  tenant: { id: string; name: string };
  nextStep: 'ONBOARDING' | 'APPLICATION';
}

export interface SessionResponse {
  data: Omit<SessionIdentity, 'sessionId'>;
  meta: { apiVersion: '1' };
}

export interface AuthenticatedRequest extends Request {
  principal: SessionIdentity;
}
