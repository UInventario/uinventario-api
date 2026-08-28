import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OfflineCommandDto } from './dto/offline-command-batch.dto';
import {
  OfflineCommandConflictError,
  OfflineCommandSequenceError,
} from './offline-command.errors';
import {
  OfflineCommandExecution,
  OfflineCommandResult,
  OfflineCommandStatus,
} from './offline-command.types';

interface CommandRow {
  command_id: string;
  sequence: string | number;
  request_fingerprint: string;
  status: OfflineCommandStatus;
  result_json: unknown;
  error_json: unknown;
}

@Injectable()
export class OfflineCommandRepository {
  constructor(private readonly dataSource: DataSource) {}

  execute(
    command: OfflineCommandDto,
    fingerprint: string,
    apply: () => Promise<OfflineCommandExecution>,
  ): Promise<OfflineCommandResult> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT IGNORE INTO offline_device_sequences
          (tenant_id, user_id, device_id, last_sequence) VALUES (?, ?, ?, 0)`,
        [command.scope.tenantId, command.scope.userId, command.scope.deviceId],
      );
      const [sequence] = await manager.query<
        Array<{ last_sequence: string | number }>
      >(
        `SELECT last_sequence FROM offline_device_sequences
         WHERE tenant_id = ? AND user_id = ? AND device_id = ? FOR UPDATE`,
        [command.scope.tenantId, command.scope.userId, command.scope.deviceId],
      );
      const existing = await this.findExisting(manager, command);
      if (existing) {
        if (
          existing.command_id !== command.commandId ||
          existing.request_fingerprint !== fingerprint ||
          Number(existing.sequence) !== command.sequence
        ) {
          throw new OfflineCommandConflictError();
        }
        await manager.query(
          `UPDATE offline_commands SET replay_count = replay_count + 1
           WHERE command_id = ?`,
          [existing.command_id],
        );
        return this.result(existing, true);
      }
      const expected = Number(sequence.last_sequence) + 1;
      if (command.sequence !== expected)
        throw new OfflineCommandSequenceError(expected);
      await manager.query(
        `INSERT INTO offline_commands
          (command_id, tenant_id, user_id, device_id, sequence, idempotency_key,
           kind, request_fingerprint, status, device_created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
        [
          command.commandId,
          command.scope.tenantId,
          command.scope.userId,
          command.scope.deviceId,
          command.sequence,
          command.idempotencyKey,
          command.kind,
          fingerprint,
          this.sqlDate(command.createdAt),
        ],
      );
      const execution = await apply();
      await manager.query(
        `UPDATE offline_commands SET status = ?, result_json = ?, error_json = ?,
           completed_at = CURRENT_TIMESTAMP(6) WHERE command_id = ?`,
        [
          execution.status,
          execution.result === undefined
            ? null
            : JSON.stringify(execution.result),
          execution.error === undefined
            ? null
            : JSON.stringify(execution.error),
          command.commandId,
        ],
      );
      await manager.query(
        `UPDATE offline_device_sequences SET last_sequence = ?
         WHERE tenant_id = ? AND user_id = ? AND device_id = ?`,
        [
          command.sequence,
          command.scope.tenantId,
          command.scope.userId,
          command.scope.deviceId,
        ],
      );
      return {
        commandId: command.commandId,
        sequence: command.sequence,
        status: execution.status,
        replay: false,
        ...(execution.result === undefined ? {} : { result: execution.result }),
        ...(execution.error === undefined ? {} : { error: execution.error }),
      };
    });
  }

  private async findExisting(
    manager: EntityManager,
    command: OfflineCommandDto,
  ): Promise<CommandRow | null> {
    const rows = await manager.query<CommandRow[]>(
      `SELECT command_id, sequence, request_fingerprint, status, result_json, error_json
       FROM offline_commands WHERE command_id = ? OR
         (tenant_id = ? AND user_id = ? AND device_id = ? AND idempotency_key = ?)
       LIMIT 1 FOR UPDATE`,
      [
        command.commandId,
        command.scope.tenantId,
        command.scope.userId,
        command.scope.deviceId,
        command.idempotencyKey,
      ],
    );
    return rows[0] ?? null;
  }

  private result(row: CommandRow, replay: boolean): OfflineCommandResult {
    return {
      commandId: row.command_id,
      sequence: Number(row.sequence),
      status: row.status,
      replay,
      ...(row.result_json === null
        ? {}
        : { result: this.json(row.result_json) }),
      ...(row.error_json === null ? {} : { error: this.json(row.error_json) }),
    };
  }

  private json(value: unknown): unknown {
    return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  }

  private sqlDate(value: string): string {
    return value.slice(0, 23).replace('T', ' ').replace('Z', '');
  }
}
