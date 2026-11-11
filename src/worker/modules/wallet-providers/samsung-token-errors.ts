export class SamsungTokenError extends Error {
  constructor() {
    super('Samsung Wallet token or request is invalid.');
    this.name = 'SamsungTokenError';
  }
}

export class SamsungReplayStoreError extends Error {
  constructor() {
    super('Samsung Wallet replay protection is unavailable.');
    this.name = 'SamsungReplayStoreError';
  }
}
