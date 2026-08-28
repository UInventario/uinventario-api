import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import {
  ListSuppliersDto,
  SupplierStatusFilter,
} from './dto/list-suppliers.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import {
  SupplierIdentifierConflictError,
  SupplierVersionConflictError,
} from './supplier.errors';
import { SupplierContactData, SupplierData } from './supplier.types';

interface SupplierRow {
  id: string;
  legal_name: string;
  trade_name: string | null;
  country_code: string;
  identifier_type: string;
  tax_identifier: string;
  active: number | boolean;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ContactRow {
  id: string;
  supplier_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  is_primary: number | boolean;
}

@Injectable()
export class SupplierRepository {
  constructor(private readonly dataSource: DataSource) {}

  async tenantCountry(tenantId: string): Promise<string | null> {
    const rows = await this.dataSource.query<
      Array<{ country_code: string | null }>
    >('SELECT country_code FROM tenants WHERE id = ? LIMIT 1', [tenantId]);
    return rows[0]?.country_code ?? null;
  }

  async create(
    tenantId: string,
    countryCode: string,
    identifierType: string,
    normalizedIdentifier: string,
    dto: CreateSupplierDto,
  ): Promise<SupplierData> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const id = randomUUID();
        await manager.query(
          `INSERT INTO suppliers
            (id, tenant_id, legal_name, trade_name, country_code, identifier_type,
             tax_identifier, normalized_tax_identifier)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            tenantId,
            dto.legalName,
            dto.tradeName ?? null,
            countryCode,
            identifierType,
            dto.taxIdentifier,
            normalizedIdentifier,
          ],
        );
        await this.replaceContacts(manager, tenantId, id, dto.contacts);
        return (await this.find(manager, tenantId, id))!;
      });
    } catch (error) {
      this.rethrowDuplicate(error);
    }
  }

  async update(
    tenantId: string,
    id: string,
    countryCode: string,
    identifierType: string,
    normalizedIdentifier: string,
    dto: UpdateSupplierDto,
  ): Promise<SupplierData | null> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const result = await manager.query<ResultSetHeader>(
          `UPDATE suppliers
           SET legal_name = ?, trade_name = ?, country_code = ?, identifier_type = ?,
               tax_identifier = ?, normalized_tax_identifier = ?, version = version + 1
           WHERE id = ? AND tenant_id = ? AND version = ?`,
          [
            dto.legalName,
            dto.tradeName ?? null,
            countryCode,
            identifierType,
            dto.taxIdentifier,
            normalizedIdentifier,
            id,
            tenantId,
            dto.version,
          ],
        );
        if (result.affectedRows === 0) {
          const current = await this.find(manager, tenantId, id);
          if (!current) return null;
          throw new SupplierVersionConflictError(current.version);
        }
        await this.replaceContacts(manager, tenantId, id, dto.contacts);
        return this.find(manager, tenantId, id);
      });
    } catch (error) {
      this.rethrowDuplicate(error);
    }
  }

  async list(
    tenantId: string,
    query: ListSuppliersDto,
  ): Promise<{ suppliers: SupplierData[]; total: number }> {
    const clauses = ['s.tenant_id = ?'];
    const parameters: Array<string | number> = [tenantId];
    if (query.status !== SupplierStatusFilter.ALL) {
      clauses.push('s.active = ?');
      parameters.push(query.status === SupplierStatusFilter.ACTIVE ? 1 : 0);
    }
    if (query.q) {
      const search = `%${query.q}%`;
      clauses.push(`(
        s.legal_name LIKE ? OR s.trade_name LIKE ? OR s.tax_identifier LIKE ?
        OR EXISTS (
          SELECT 1 FROM supplier_contacts sc
          WHERE sc.tenant_id = s.tenant_id AND sc.supplier_id = s.id
            AND (sc.name LIKE ? OR sc.email LIKE ? OR sc.phone LIKE ?)
        )
      )`);
      parameters.push(search, search, search, search, search, search);
    }
    const where = clauses.join(' AND ');
    const offset = (query.page - 1) * query.pageSize;
    const [rows, [count]] = await Promise.all([
      this.dataSource.query<SupplierRow[]>(
        `${this.select()} WHERE ${where}
         ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
        [...parameters, query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM suppliers s WHERE ${where}`,
        parameters,
      ),
    ]);
    return {
      suppliers: await this.withContacts(
        this.dataSource.manager,
        tenantId,
        rows,
      ),
      total: Number(count.total),
    };
  }

  findById(tenantId: string, id: string): Promise<SupplierData | null> {
    return this.find(this.dataSource.manager, tenantId, id);
  }

  async deactivate(tenantId: string, id: string): Promise<SupplierData | null> {
    return this.dataSource.transaction(async (manager) => {
      const existing = await this.find(manager, tenantId, id, true);
      if (!existing) return null;
      if (existing.active) {
        await manager.query(
          `UPDATE suppliers SET active = FALSE, version = version + 1
           WHERE id = ? AND tenant_id = ?`,
          [id, tenantId],
        );
      }
      return this.find(manager, tenantId, id);
    });
  }

  private async replaceContacts(
    manager: EntityManager,
    tenantId: string,
    supplierId: string,
    contacts: CreateSupplierDto['contacts'],
  ): Promise<void> {
    await manager.query(
      'DELETE FROM supplier_contacts WHERE tenant_id = ? AND supplier_id = ?',
      [tenantId, supplierId],
    );
    for (const contact of contacts) {
      await manager.query(
        `INSERT INTO supplier_contacts
          (id, tenant_id, supplier_id, name, email, phone, role, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          tenantId,
          supplierId,
          contact.name,
          contact.email?.toLowerCase() ?? null,
          contact.phone ?? null,
          contact.role ?? null,
          contact.primary,
        ],
      );
    }
  }

  private async find(
    manager: EntityManager,
    tenantId: string,
    id: string,
    lock = false,
  ): Promise<SupplierData | null> {
    const rows = await manager.query<SupplierRow[]>(
      `${this.select()} WHERE s.id = ? AND s.tenant_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [id, tenantId],
    );
    if (!rows[0]) return null;
    return (await this.withContacts(manager, tenantId, rows))[0];
  }

  private async withContacts(
    manager: EntityManager,
    tenantId: string,
    rows: SupplierRow[],
  ): Promise<SupplierData[]> {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => '?').join(',');
    const contacts = await manager.query<ContactRow[]>(
      `SELECT id, supplier_id, name, email, phone, role, is_primary
       FROM supplier_contacts WHERE tenant_id = ? AND supplier_id IN (${placeholders})
       ORDER BY is_primary DESC, name, id`,
      [tenantId, ...rows.map((row) => row.id)],
    );
    return rows.map((row) => this.toSupplier(row, contacts));
  }

  private toSupplier(row: SupplierRow, contacts: ContactRow[]): SupplierData {
    return {
      id: row.id,
      legalName: row.legal_name,
      tradeName: row.trade_name,
      countryCode: row.country_code,
      identifierType: row.identifier_type,
      taxIdentifier: row.tax_identifier,
      active: Boolean(row.active),
      version: Number(row.version),
      contacts: contacts
        .filter((contact) => contact.supplier_id === row.id)
        .map((contact): SupplierContactData => ({
          id: contact.id,
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          role: contact.role,
          primary: Boolean(contact.is_primary),
        })),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private select(): string {
    return `SELECT s.id, s.legal_name, s.trade_name, s.country_code,
                   s.identifier_type, s.tax_identifier, s.active, s.version,
                   s.created_at, s.updated_at
            FROM suppliers s`;
  }

  private rethrowDuplicate(error: unknown): never {
    if (error instanceof QueryFailedError) {
      const driver = error.driverError as {
        errno?: number;
        sqlMessage?: string;
      };
      if (
        driver.errno === 1062 &&
        driver.sqlMessage?.includes('uq_suppliers_tenant_identifier')
      ) {
        throw new SupplierIdentifierConflictError();
      }
    }
    throw error;
  }
}
