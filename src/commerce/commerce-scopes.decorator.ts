import { SetMetadata } from '@nestjs/common';
import type { CommerceScope } from './commerce.types';

export const COMMERCE_SCOPES_KEY = 'commerceScopes';
export const RequireCommerceScopes = (...scopes: CommerceScope[]) =>
  SetMetadata(COMMERCE_SCOPES_KEY, scopes);
