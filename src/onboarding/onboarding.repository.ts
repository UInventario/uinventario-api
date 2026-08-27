import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { TenantEntity } from '../tenancy/entities/tenant.entity';
import { ConfigureInitialCashRegisterDto } from './dto/configure-initial-cash-register.dto';
import { ConfigureInitialLocationDto } from './dto/configure-initial-location.dto';
import {
  InitialCashRegisterData,
  InitialLocationData,
} from './onboarding.types';

interface InitialLocationRow {
  branch_id: string;
  branch_name: string;
  timezone: string;
  warehouse_id: string;
  warehouse_name: string;
  location_id: string;
  location_name: string;
  location_code: string;
}

interface InitialCashRegisterRow {
  cash_register_id: string;
  cash_register_name: string;
  cash_register_code: string;
  branch_id: string;
  branch_name: string;
}

export interface CompanyProfile {
  legalName: string | null;
  tradeName: string;
  countryCode: string | null;
  onboardingCompletedAt: Date | null;
}

@Injectable()
export class OnboardingRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findCompany(tenantId: string): Promise<CompanyProfile | null> {
    const tenant = await this.dataSource.manager.findOne(TenantEntity, {
      where: { id: tenantId },
    });
    if (!tenant) return null;

    return {
      legalName: tenant.legalName,
      tradeName: tenant.name,
      countryCode: tenant.countryCode,
      onboardingCompletedAt: tenant.onboardingCompletedAt,
    };
  }

  async updateCompany(
    tenantId: string,
    input: { legalName: string; tradeName: string; countryCode: string },
  ): Promise<void> {
    await this.dataSource.manager.update(
      TenantEntity,
      { id: tenantId },
      {
        legalName: input.legalName,
        name: input.tradeName,
        countryCode: input.countryCode,
      },
    );
  }

  async findInitialLocation(
    tenantId: string,
  ): Promise<InitialLocationData | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      return await this.findInitialLocationWithRunner(queryRunner, tenantId);
    } finally {
      await queryRunner.release();
    }
  }

  async createInitialLocation(
    tenantId: string,
    sessionId: string,
    dto: ConfigureInitialLocationDto,
  ): Promise<InitialLocationData> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const tenantRows = (await queryRunner.query(
        'SELECT legal_name, country_code FROM tenants WHERE id = ? FOR UPDATE',
        [tenantId],
      )) as Array<{ legal_name: string | null; country_code: string | null }>;
      const [tenant] = tenantRows;
      if (!tenant?.legal_name || !tenant.country_code) {
        throw new Error('COMPANY_NOT_CONFIGURED');
      }

      let initial = await this.findInitialLocationWithRunner(
        queryRunner,
        tenantId,
      );
      if (!initial) {
        const branchId = randomUUID();
        const warehouseId = randomUUID();
        const locationId = randomUUID();
        await queryRunner.query(
          `INSERT INTO branches (id, tenant_id, name, timezone, onboarding_key)
           VALUES (?, ?, ?, ?, 'INITIAL')`,
          [branchId, tenantId, dto.branchName, dto.timezone],
        );
        await queryRunner.query(
          `INSERT INTO warehouses (id, tenant_id, branch_id, name, onboarding_key)
           VALUES (?, ?, ?, ?, 'INITIAL')`,
          [warehouseId, tenantId, branchId, dto.warehouseName],
        );
        await queryRunner.query(
          `INSERT INTO locations (id, tenant_id, warehouse_id, name, code, onboarding_key)
           VALUES (?, ?, ?, ?, 'GENERAL', 'INITIAL')`,
          [locationId, tenantId, warehouseId, dto.locationName],
        );
        initial = {
          branch: {
            id: branchId,
            name: dto.branchName,
            timezone: dto.timezone,
          },
          warehouse: { id: warehouseId, name: dto.warehouseName },
          location: { id: locationId, name: dto.locationName, code: 'GENERAL' },
          progress: {
            currentStep: 'REGISTER',
            completedSteps: ['COMPANY', 'BRANCH'],
          },
        };
      }

      await queryRunner.query(
        `UPDATE sessions SET active_branch_id = ?, active_warehouse_id = ?
         WHERE id = ? AND tenant_id = ?`,
        [initial.branch.id, initial.warehouse.id, sessionId, tenantId],
      );
      await queryRunner.commitTransaction();
      return initial;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async findInitialCashRegister(
    tenantId: string,
  ): Promise<InitialCashRegisterData | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      return await this.findInitialCashRegisterWithRunner(
        queryRunner,
        tenantId,
      );
    } finally {
      await queryRunner.release();
    }
  }

  async createInitialCashRegister(
    tenantId: string,
    sessionId: string,
    dto: ConfigureInitialCashRegisterDto,
  ): Promise<InitialCashRegisterData> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const tenantRows = (await queryRunner.query(
        'SELECT id FROM tenants WHERE id = ? FOR UPDATE',
        [tenantId],
      )) as Array<{ id: string }>;
      if (!tenantRows[0]) throw new Error('TENANT_NOT_FOUND');

      const location = await this.findInitialLocationWithRunner(
        queryRunner,
        tenantId,
      );
      if (!location) throw new Error('INITIAL_LOCATION_NOT_CONFIGURED');

      let initial = await this.findInitialCashRegisterWithRunner(
        queryRunner,
        tenantId,
      );
      if (!initial) {
        const cashRegisterId = randomUUID();
        await queryRunner.query(
          `INSERT INTO cash_registers (id, tenant_id, branch_id, name, code, onboarding_key)
           VALUES (?, ?, ?, ?, 'MAIN', 'INITIAL')`,
          [cashRegisterId, tenantId, location.branch.id, dto.name],
        );
        initial = {
          cashRegister: { id: cashRegisterId, name: dto.name, code: 'MAIN' },
          branch: { id: location.branch.id, name: location.branch.name },
          progress: {
            currentStep: 'COMPLETE',
            completedSteps: ['COMPANY', 'BRANCH', 'REGISTER'],
          },
        };
      }

      await queryRunner.query(
        'UPDATE tenants SET onboarding_completed_at = COALESCE(onboarding_completed_at, CURRENT_TIMESTAMP(6)) WHERE id = ?',
        [tenantId],
      );
      await queryRunner.query(
        `UPDATE sessions
         SET active_branch_id = ?, active_warehouse_id = ?, active_cash_register_id = ?
         WHERE id = ? AND tenant_id = ?`,
        [
          location.branch.id,
          location.warehouse.id,
          initial.cashRegister.id,
          sessionId,
          tenantId,
        ],
      );
      await queryRunner.commitTransaction();
      return initial;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async findInitialLocationWithRunner(
    queryRunner: QueryRunner,
    tenantId: string,
  ): Promise<InitialLocationData | null> {
    const rows = (await queryRunner.query(
      `SELECT b.id AS branch_id, b.name AS branch_name, b.timezone,
              w.id AS warehouse_id, w.name AS warehouse_name,
              l.id AS location_id, l.name AS location_name, l.code AS location_code
       FROM branches b
       INNER JOIN warehouses w ON w.branch_id = b.id AND w.tenant_id = b.tenant_id AND w.onboarding_key = 'INITIAL'
       INNER JOIN locations l ON l.warehouse_id = w.id AND l.tenant_id = b.tenant_id AND l.onboarding_key = 'INITIAL'
       WHERE b.tenant_id = ? AND b.onboarding_key = 'INITIAL' LIMIT 1`,
      [tenantId],
    )) as InitialLocationRow[];
    const [row] = rows;
    if (!row) return null;
    return {
      branch: {
        id: row.branch_id,
        name: row.branch_name,
        timezone: row.timezone,
      },
      warehouse: { id: row.warehouse_id, name: row.warehouse_name },
      location: {
        id: row.location_id,
        name: row.location_name,
        code: row.location_code,
      },
      progress: {
        currentStep: 'REGISTER',
        completedSteps: ['COMPANY', 'BRANCH'],
      },
    };
  }

  private async findInitialCashRegisterWithRunner(
    queryRunner: QueryRunner,
    tenantId: string,
  ): Promise<InitialCashRegisterData | null> {
    const rows = (await queryRunner.query(
      `SELECT cr.id AS cash_register_id, cr.name AS cash_register_name,
              cr.code AS cash_register_code, b.id AS branch_id, b.name AS branch_name
       FROM cash_registers cr
       INNER JOIN branches b ON b.id = cr.branch_id AND b.tenant_id = cr.tenant_id
       WHERE cr.tenant_id = ? AND cr.onboarding_key = 'INITIAL' LIMIT 1`,
      [tenantId],
    )) as InitialCashRegisterRow[];
    const [row] = rows;
    if (!row) return null;
    return {
      cashRegister: {
        id: row.cash_register_id,
        name: row.cash_register_name,
        code: row.cash_register_code,
      },
      branch: { id: row.branch_id, name: row.branch_name },
      progress: {
        currentStep: 'COMPLETE',
        completedSteps: ['COMPANY', 'BRANCH', 'REGISTER'],
      },
    };
  }
}
