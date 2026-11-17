import { AsyncLocalStorage } from 'node:async_hooks';

// vitest 5 calls disable() after async mock factories settle; workerd's AsyncLocalStorage does not implement it.
AsyncLocalStorage.prototype.disable = () => {};
