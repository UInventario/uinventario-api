import { Injectable } from '@nestjs/common';
import type { PosPeripheralAction } from './pos-peripheral.types';

export const POS_PERIPHERAL_ADAPTER = Symbol('POS_PERIPHERAL_ADAPTER');

export interface PosPeripheralAdapter {
  execute(input: {
    deviceId: string;
    action: PosPeripheralAction;
    saleId: string | null;
  }): Promise<void>;
}

export class PosPeripheralAdapterError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

@Injectable()
export class SimulatorPosPeripheralAdapter implements PosPeripheralAdapter {
  execute(input: {
    deviceId: string;
    action: PosPeripheralAction;
    saleId: string | null;
  }): Promise<void> {
    if (input.deviceId.toUpperCase().startsWith('FAIL-')) {
      return Promise.reject(
        new PosPeripheralAdapterError('DEVICE_UNAVAILABLE'),
      );
    }
    return Promise.resolve();
  }
}
