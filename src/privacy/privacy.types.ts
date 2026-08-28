export interface PrivacyPolicyData {
  countryCode: string;
  minimumTransactionRetentionDays: number;
  transactionRetentionDays: number;
  policyCode: string;
  version: number;
  updatedAt: string;
}

export interface PrivacyLegalHoldData {
  id: string;
  active: boolean;
  reason: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface PrivacyRequestData {
  id: string;
  type:
    | 'ACCESS_EXPORT'
    | 'ANONYMIZATION'
    | 'LEGAL_HOLD'
    | 'LEGAL_HOLD_RELEASE'
    | 'POLICY_CHANGE';
  status: 'COMPLETED' | 'BLOCKED';
  decisionCode: string;
  requestReference: string | null;
  createdAt: string;
}
