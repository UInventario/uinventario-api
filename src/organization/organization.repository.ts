import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { CreateBranchDto } from './dto/create-branch.dto';
import { CreateCashRegisterDto } from './dto/create-cash-register.dto';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';
import {
  InitialOrganizationTargetError,
  OrganizationInUseError,
  OrganizationNameConflictError,
  OrganizationTargetNotFoundError,
} from './organization.errors';
import {
  OrganizationBranchData,
  OrganizationWarehouseData,
} from './organization.types';

interface OrganizationRow {
  branch_id: string;
  branch_name: string;
  timezone: string;
  branch_active: number | boolean;
  warehouse_id: string | null;
  warehouse_name: string | null;
  warehouse_active: number | boolean | null;
  location_id: string | null;
  location_name: string | null;
  location_code: string | null;
  location_active: number | boolean | null;
}

@Injectable()
export class OrganizationRepository {
  constructor(private readonly dataSource: DataSource) {}

  async list(
    tenantId: string,
    userId: string,
    administrator: boolean,
  ): Promise<OrganizationBranchData[]> {
    const rows = await this.dataSource.query<OrganizationRow[]>(
      `SELECT b.id AS branch_id, b.name AS branch_name, b.timezone,
              b.active AS branch_active,
              w.id AS warehouse_id, w.name AS warehouse_name,
              w.active AS warehouse_active,
              l.id AS location_id, l.name AS location_name, l.code AS location_code,
              l.active AS location_active
       FROM branches b
       LEFT JOIN warehouses w ON w.branch_id = b.id AND w.tenant_id = b.tenant_id
       LEFT JOIN locations l ON l.warehouse_id = w.id AND l.tenant_id = b.tenant_id
       WHERE b.tenant_id = ?
         AND (? = TRUE OR EXISTS (
           SELECT 1 FROM user_branch_access uba
           WHERE uba.user_id = ? AND uba.tenant_id = b.tenant_id
             AND uba.branch_id = b.id
         ))
       ORDER BY (b.onboarding_key = 'INITIAL') DESC, b.created_at, b.id,
                (w.onboarding_key = 'INITIAL') DESC, w.created_at, w.id,
                (l.onboarding_key = 'INITIAL') DESC, l.created_at, l.id`,
      [tenantId, administrator, userId],
    );
    const branches = this.toBranches(rows);
    await this.attachCashRegisters(
      branches,
      tenantId,
      administrator ? null : userId,
    );
    return branches;
  }

  async createBranch(
    tenantId: string,
    dto: CreateBranchDto,
  ): Promise<OrganizationBranchData> {
    const branchId = randomUUID();
    const warehouseId = randomUUID();
    const locationId = randomUUID();
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO branches (id, tenant_id, name, timezone, active)
           VALUES (?, ?, ?, ?, TRUE)`,
          [branchId, tenantId, dto.name, dto.timezone],
        );
        await manager.query(
          `INSERT INTO warehouses (id, tenant_id, branch_id, name, active)
           VALUES (?, ?, ?, ?, TRUE)`,
          [warehouseId, tenantId, branchId, dto.warehouseName],
        );
        await manager.query(
          `INSERT INTO locations (id, tenant_id, warehouse_id, name, code, active)
           VALUES (?, ?, ?, ?, ?, TRUE)`,
          [
            locationId,
            tenantId,
            warehouseId,
            dto.locationName,
            dto.locationCode.toUpperCase(),
          ],
        );
      });
    } catch (error) {
      if (this.isDuplicate(error)) throw new OrganizationNameConflictError();
      throw error;
    }
    return (await this.findBranch(tenantId, branchId))!;
  }

  async updateBranch(
    tenantId: string,
    branchId: string,
    dto: UpdateBranchDto,
  ): Promise<OrganizationBranchData> {
    try {
      const result = await this.dataSource.query<{ affectedRows?: number }>(
        `UPDATE branches SET name = ?, timezone = ?
         WHERE id = ? AND tenant_id = ? AND active = TRUE`,
        [dto.name, dto.timezone, branchId, tenantId],
      );
      if (this.affectedRows(result) !== 1)
        throw new OrganizationTargetNotFoundError();
    } catch (error) {
      if (this.isDuplicate(error)) throw new OrganizationNameConflictError();
      throw error;
    }
    return (await this.findBranch(tenantId, branchId))!;
  }

  async createWarehouse(
    tenantId: string,
    branchId: string,
    dto: CreateWarehouseDto,
  ): Promise<OrganizationWarehouseData & { branchId: string }> {
    const warehouseId = randomUUID();
    const locationId = randomUUID();
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.assertActiveBranch(manager, tenantId, branchId);
        await manager.query(
          `INSERT INTO warehouses (id, tenant_id, branch_id, name, active)
           VALUES (?, ?, ?, ?, TRUE)`,
          [warehouseId, tenantId, branchId, dto.name],
        );
        await manager.query(
          `INSERT INTO locations (id, tenant_id, warehouse_id, name, code, active)
           VALUES (?, ?, ?, ?, ?, TRUE)`,
          [
            locationId,
            tenantId,
            warehouseId,
            dto.locationName,
            dto.locationCode.toUpperCase(),
          ],
        );
      });
    } catch (error) {
      if (this.isDuplicate(error)) throw new OrganizationNameConflictError();
      throw error;
    }
    return (await this.findWarehouse(tenantId, warehouseId))!;
  }

  async createCashRegister(
    tenantId: string,
    branchId: string,
    dto: CreateCashRegisterDto,
  ): Promise<{ id: string; name: string; code: string; branchId: string }> {
    const id = randomUUID();
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.assertActiveBranch(manager, tenantId, branchId);
        await manager.query(
          `INSERT INTO cash_registers (id, tenant_id, branch_id, name, code)
           VALUES (?, ?, ?, ?, ?)`,
          [id, tenantId, branchId, dto.name, dto.code],
        );
      });
    } catch (error) {
      if (this.isDuplicate(error)) throw new OrganizationNameConflictError();
      throw error;
    }
    return { id, name: dto.name, code: dto.code, branchId };
  }

  async updateWarehouse(
    tenantId: string,
    warehouseId: string,
    dto: UpdateWarehouseDto,
  ): Promise<OrganizationWarehouseData & { branchId: string }> {
    try {
      const result = await this.dataSource.query<{ affectedRows?: number }>(
        `UPDATE warehouses SET name = ?
         WHERE id = ? AND tenant_id = ? AND active = TRUE`,
        [dto.name, warehouseId, tenantId],
      );
      if (this.affectedRows(result) !== 1)
        throw new OrganizationTargetNotFoundError();
    } catch (error) {
      if (this.isDuplicate(error)) throw new OrganizationNameConflictError();
      throw error;
    }
    return (await this.findWarehouse(tenantId, warehouseId))!;
  }

  async retireBranch(tenantId: string, branchId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const [branch] = await manager.query<
        Array<{ onboarding_key: string | null }>
      >(
        `SELECT onboarding_key FROM branches
         WHERE id = ? AND tenant_id = ? AND active = TRUE FOR UPDATE`,
        [branchId, tenantId],
      );
      if (!branch) throw new OrganizationTargetNotFoundError();
      if (branch.onboarding_key === 'INITIAL')
        throw new InitialOrganizationTargetError();
      const usage = await this.branchUsage(manager, tenantId, branchId);
      if (usage > 0) throw new OrganizationInUseError();
      await manager.query(
        `UPDATE locations l
         INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
         SET l.active = FALSE
         WHERE l.tenant_id = ? AND w.branch_id = ?`,
        [tenantId, branchId],
      );
      await manager.query(
        'UPDATE warehouses SET active = FALSE WHERE tenant_id = ? AND branch_id = ?',
        [tenantId, branchId],
      );
      await manager.query(
        'UPDATE branches SET active = FALSE WHERE tenant_id = ? AND id = ?',
        [tenantId, branchId],
      );
    });
  }

  async retireWarehouse(tenantId: string, warehouseId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const [warehouse] = await manager.query<
        Array<{ onboarding_key: string | null }>
      >(
        `SELECT onboarding_key FROM warehouses
         WHERE id = ? AND tenant_id = ? AND active = TRUE FOR UPDATE`,
        [warehouseId, tenantId],
      );
      if (!warehouse) throw new OrganizationTargetNotFoundError();
      if (warehouse.onboarding_key === 'INITIAL')
        throw new InitialOrganizationTargetError();
      const usage = await this.warehouseUsage(manager, tenantId, warehouseId);
      if (usage > 0) throw new OrganizationInUseError();
      await manager.query(
        'UPDATE locations SET active = FALSE WHERE tenant_id = ? AND warehouse_id = ?',
        [tenantId, warehouseId],
      );
      await manager.query(
        'UPDATE warehouses SET active = FALSE WHERE tenant_id = ? AND id = ?',
        [tenantId, warehouseId],
      );
    });
  }

  private async findBranch(
    tenantId: string,
    branchId: string,
  ): Promise<OrganizationBranchData | null> {
    const rows = await this.dataSource.query<OrganizationRow[]>(
      `SELECT b.id AS branch_id, b.name AS branch_name, b.timezone,
              b.active AS branch_active,
              w.id AS warehouse_id, w.name AS warehouse_name,
              w.active AS warehouse_active,
              l.id AS location_id, l.name AS location_name, l.code AS location_code,
              l.active AS location_active
       FROM branches b
       LEFT JOIN warehouses w ON w.branch_id = b.id AND w.tenant_id = b.tenant_id
       LEFT JOIN locations l ON l.warehouse_id = w.id AND l.tenant_id = b.tenant_id
       WHERE b.tenant_id = ? AND b.id = ?
       ORDER BY w.created_at, w.id, l.created_at, l.id`,
      [tenantId, branchId],
    );
    const branches = this.toBranches(rows);
    await this.attachCashRegisters(branches, tenantId, null);
    return branches[0] ?? null;
  }

  private async findWarehouse(
    tenantId: string,
    warehouseId: string,
  ): Promise<(OrganizationWarehouseData & { branchId: string }) | null> {
    const rows = await this.dataSource.query<
      Array<{
        branch_id: string;
        warehouse_id: string;
        warehouse_name: string;
        warehouse_active: number | boolean;
        location_id: string | null;
        location_name: string | null;
        location_code: string | null;
        location_active: number | boolean | null;
      }>
    >(
      `SELECT w.branch_id, w.id AS warehouse_id, w.name AS warehouse_name,
              w.active AS warehouse_active,
              l.id AS location_id, l.name AS location_name, l.code AS location_code,
              l.active AS location_active
       FROM warehouses w
       LEFT JOIN locations l ON l.warehouse_id = w.id AND l.tenant_id = w.tenant_id
       WHERE w.tenant_id = ? AND w.id = ?
       ORDER BY l.created_at, l.id`,
      [tenantId, warehouseId],
    );
    if (!rows[0]) return null;
    return {
      branchId: rows[0].branch_id,
      id: rows[0].warehouse_id,
      name: rows[0].warehouse_name,
      active: Boolean(rows[0].warehouse_active),
      locations: rows.flatMap((row) =>
        row.location_id && row.location_name && row.location_code
          ? [
              {
                id: row.location_id,
                name: row.location_name,
                code: row.location_code,
                active: Boolean(row.location_active),
              },
            ]
          : [],
      ),
    };
  }

  private toBranches(rows: OrganizationRow[]): OrganizationBranchData[] {
    const branches = new Map<string, OrganizationBranchData>();
    const warehouses = new Map<string, OrganizationWarehouseData>();
    for (const row of rows) {
      let branch = branches.get(row.branch_id);
      if (!branch) {
        branch = {
          id: row.branch_id,
          name: row.branch_name,
          timezone: row.timezone,
          active: Boolean(row.branch_active),
          warehouses: [],
          cashRegisters: [],
        };
        branches.set(row.branch_id, branch);
      }
      if (!row.warehouse_id || !row.warehouse_name) continue;
      let warehouse = warehouses.get(row.warehouse_id);
      if (!warehouse) {
        warehouse = {
          id: row.warehouse_id,
          name: row.warehouse_name,
          active: Boolean(row.warehouse_active),
          locations: [],
        };
        warehouses.set(row.warehouse_id, warehouse);
        branch.warehouses.push(warehouse);
      }
      if (row.location_id && row.location_name && row.location_code) {
        warehouse.locations.push({
          id: row.location_id,
          name: row.location_name,
          code: row.location_code,
          active: Boolean(row.location_active),
        });
      }
    }
    return [...branches.values()];
  }

  private async attachCashRegisters(
    branches: OrganizationBranchData[],
    tenantId: string,
    userId: string | null,
  ): Promise<void> {
    if (branches.length === 0) return;
    const rows = await this.dataSource.query<
      Array<{ id: string; name: string; code: string; branch_id: string }>
    >(
      `SELECT cr.id, cr.name, cr.code, cr.branch_id
       FROM cash_registers cr
       WHERE cr.tenant_id = ? AND cr.branch_id IN (?)
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM user_cash_register_access ucra
           WHERE ucra.user_id = ? AND ucra.tenant_id = cr.tenant_id
             AND ucra.branch_id = cr.branch_id AND ucra.cash_register_id = cr.id
         ))
       ORDER BY cr.created_at, cr.id`,
      [tenantId, branches.map((branch) => branch.id), userId, userId],
    );
    const byId = new Map(branches.map((branch) => [branch.id, branch]));
    for (const row of rows) {
      byId.get(row.branch_id)?.cashRegisters.push({
        id: row.id,
        name: row.name,
        code: row.code,
      });
    }
  }

  private async assertActiveBranch(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
  ): Promise<void> {
    const [branch] = await manager.query<Array<{ id: string }>>(
      'SELECT id FROM branches WHERE id = ? AND tenant_id = ? AND active = TRUE LIMIT 1',
      [branchId, tenantId],
    );
    if (!branch) throw new OrganizationTargetNotFoundError();
  }

  private async branchUsage(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
  ): Promise<number> {
    const [row] = await manager.query<Array<{ total: number | string }>>(
      `SELECT
        (SELECT COUNT(*) FROM inventory_movements im
         INNER JOIN locations l ON l.id = im.location_id AND l.tenant_id = im.tenant_id
         INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
         WHERE im.tenant_id = ? AND w.branch_id = ?) +
        (SELECT COUNT(*) FROM inventory_balances ib
         INNER JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
         INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
         WHERE ib.tenant_id = ? AND w.branch_id = ? AND ib.quantity <> 0) +
        (SELECT COUNT(*) FROM sales s WHERE s.tenant_id = ? AND s.branch_id = ?) +
        (SELECT COUNT(*) FROM sessions s WHERE s.tenant_id = ? AND s.active_branch_id = ?
          AND s.revoked_at IS NULL AND s.expires_at > ?) AS total`,
      [
        tenantId,
        branchId,
        tenantId,
        branchId,
        tenantId,
        branchId,
        tenantId,
        branchId,
        new Date(),
      ],
    );
    return Number(row?.total ?? 0);
  }

  private async warehouseUsage(
    manager: EntityManager,
    tenantId: string,
    warehouseId: string,
  ): Promise<number> {
    const [row] = await manager.query<Array<{ total: number | string }>>(
      `SELECT
        (SELECT COUNT(*) FROM inventory_movements im
         INNER JOIN locations l ON l.id = im.location_id AND l.tenant_id = im.tenant_id
         WHERE im.tenant_id = ? AND l.warehouse_id = ?) +
        (SELECT COUNT(*) FROM inventory_balances ib
         INNER JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
         WHERE ib.tenant_id = ? AND l.warehouse_id = ? AND ib.quantity <> 0) +
        (SELECT COUNT(*) FROM sales s WHERE s.tenant_id = ? AND s.warehouse_id = ?) +
        (SELECT COUNT(*) FROM sessions s WHERE s.tenant_id = ? AND s.active_warehouse_id = ?
          AND s.revoked_at IS NULL AND s.expires_at > ?) AS total`,
      [
        tenantId,
        warehouseId,
        tenantId,
        warehouseId,
        tenantId,
        warehouseId,
        tenantId,
        warehouseId,
        new Date(),
      ],
    );
    return Number(row?.total ?? 0);
  }

  private affectedRows(result: { affectedRows?: number }): number {
    return Number(result.affectedRows ?? 0);
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }
}
