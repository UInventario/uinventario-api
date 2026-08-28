export class OfflineCommandConflictError extends Error {}
export class OfflineCommandSequenceError extends Error {
  constructor(readonly expectedSequence: number) {
    super('OFFLINE_COMMAND_SEQUENCE_GAP');
  }
}
