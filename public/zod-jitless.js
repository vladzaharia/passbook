// zod probes `Function('')` when its first schema is built, which is before any module of the app
// runs: a CSP and Trusted Types violation on every page. zod reads this global at that moment.
globalThis.__zod_globalConfig = { ...globalThis.__zod_globalConfig, jitless: true };
