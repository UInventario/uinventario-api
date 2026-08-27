export interface CompanyOnboardingData {
  company: {
    legalName: string | null;
    tradeName: string;
    countryCode: string | null;
  };
  progress: {
    currentStep: 'COMPANY' | 'BRANCH' | 'COMPLETE';
    completedSteps: Array<'COMPANY' | 'BRANCH'>;
  };
}

export interface CompanyOnboardingResponse {
  data: CompanyOnboardingData;
  meta: { apiVersion: '1' };
}

export interface InitialLocationData {
  branch: { id: string; name: string; timezone: string };
  warehouse: { id: string; name: string };
  location: { id: string; name: string; code: string };
  progress: { currentStep: 'REGISTER'; completedSteps: ['COMPANY', 'BRANCH'] };
}

export interface InitialLocationResponse {
  data: InitialLocationData | null;
  meta: { apiVersion: '1' };
}

export interface InitialCashRegisterData {
  cashRegister: { id: string; name: string; code: string };
  branch: { id: string; name: string };
  progress: {
    currentStep: 'COMPLETE';
    completedSteps: ['COMPANY', 'BRANCH', 'REGISTER'];
  };
}

export interface InitialCashRegisterResponse {
  data: InitialCashRegisterData | null;
  meta: { apiVersion: '1' };
}
