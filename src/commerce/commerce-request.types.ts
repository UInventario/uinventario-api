import type { Request } from 'express';
import type { CommercePrincipal } from './commerce.types';

export interface CommerceRequest extends Request {
  commercePrincipal: CommercePrincipal;
}
