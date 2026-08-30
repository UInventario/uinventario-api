import { fiscalProviderAdapterContract } from './fiscal-provider-adapter.contract';
import { SimulatedFiscalAdapter } from './simulated-fiscal.adapter';

fiscalProviderAdapterContract(() => new SimulatedFiscalAdapter());
