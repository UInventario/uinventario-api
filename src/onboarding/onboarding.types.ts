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
