export type OfflineCommandStatus = 'CONFIRMED' | 'ERROR';

export interface OfflineCommandResult {
  commandId: string;
  sequence: number;
  status: OfflineCommandStatus;
  replay: boolean;
  result?: unknown;
  error?: unknown;
}

export interface OfflineCommandExecution {
  status: OfflineCommandStatus;
  result?: unknown;
  error?: unknown;
}
