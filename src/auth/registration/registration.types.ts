export interface RegistrationInput {
  idempotencyKey: string;
  requestFingerprint: string;
  organizationName: string;
  email: string;
  normalizedEmail: string;
  passwordHash: string;
}

export interface RegistrationResult {
  tenant: { id: string; name: string };
  user: { id: string; email: string };
}

export interface RegistrationResponse {
  data: RegistrationResult & { nextStep: 'LOGIN' };
  meta: { apiVersion: '1' };
}
