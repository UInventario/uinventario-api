import type { Request } from 'express';
import type { SessionIdentity } from '../auth/session/session.types';

export interface RequestContext extends Request {
  requestId?: string;
  principal?: SessionIdentity;
}
