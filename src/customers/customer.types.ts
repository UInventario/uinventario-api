export interface CustomerData {
  id: string;
  name: string;
  identifier: string | null;
  email: string | null;
  phone: string | null;
  dataProcessingConsent: boolean;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
