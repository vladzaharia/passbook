import sdkStatus from '../../docs/developers/sdk-status.json' with { type: 'json' };

/** Which SDKs are published. Samples, install lines and badges follow it; the owner flips a flag after publishing. */
export interface SdkStatus {
  typescript: boolean;
  python: boolean;
  go: boolean;
  cli: boolean;
}

/** The languages that have samples. */
export type SampleSdks = Pick<SdkStatus, 'typescript' | 'python' | 'go'>;

export const SDK_STATUS: SdkStatus = sdkStatus;

export const anySdk = (s: SdkStatus = SDK_STATUS): boolean => s.typescript || s.python || s.go;
