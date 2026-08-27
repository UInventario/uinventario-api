export interface OrganizationLocationData {
  id: string;
  name: string;
  code: string;
  active: boolean;
}

export interface OrganizationWarehouseData {
  id: string;
  name: string;
  active: boolean;
  locations: OrganizationLocationData[];
}

export interface OrganizationBranchData {
  id: string;
  name: string;
  timezone: string;
  active: boolean;
  warehouses: OrganizationWarehouseData[];
  cashRegisters: Array<{ id: string; name: string; code: string }>;
}

export interface OrganizationListResponse {
  data: OrganizationBranchData[];
  meta: { apiVersion: '1' };
}

export interface OrganizationBranchResponse {
  data: OrganizationBranchData;
  meta: { apiVersion: '1' };
}

export interface OrganizationWarehouseResponse {
  data: OrganizationWarehouseData & { branchId: string };
  meta: { apiVersion: '1' };
}

export interface OrganizationCashRegisterResponse {
  data: { id: string; name: string; code: string; branchId: string };
  meta: { apiVersion: '1' };
}

export interface OrganizationRetirementResponse {
  data: { id: string; active: false };
  meta: { apiVersion: '1' };
}
