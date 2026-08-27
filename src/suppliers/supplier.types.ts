export interface SupplierContactData {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  primary: boolean;
}

export interface SupplierData {
  id: string;
  legalName: string;
  tradeName: string | null;
  countryCode: string;
  identifierType: string;
  taxIdentifier: string;
  active: boolean;
  version: number;
  contacts: SupplierContactData[];
  createdAt: string;
  updatedAt: string;
}

export interface SupplierResponse {
  data: SupplierData;
  meta: { apiVersion: '1' };
}

export interface SupplierListResponse {
  data: SupplierData[];
  meta: {
    apiVersion: '1';
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };
  };
}
