/** Version and delivery history included in pass-detail fixtures. */
export function passVersions() {
  return [
    {
      version: 3,
      templateVersion: 'a1b2c3d4e5f6a7b8',
      cause: 'admin',
      actorType: 'user',
      actorId: 'u1',
      createdAt: 3,
      purged: false,
    },
    {
      version: 2,
      templateVersion: 'a1b2c3d4e5f6a7b8',
      cause: 'create',
      actorType: 'user',
      actorId: 'u1',
      createdAt: 2,
      purged: false,
    },
    {
      version: 1,
      templateVersion: 'a1b2c3d4e5f6a7b8',
      cause: 'create',
      actorType: null,
      actorId: null,
      createdAt: 1,
      purged: true,
    },
  ];
}

export function passDeliveries() {
  return [
    {
      id: 'd1',
      kind: 'email',
      state: 'failed',
      attempts: 3,
      errorCode: 'MAIL_REJECTED',
      createdAt: 5,
      finishedAt: 6,
    },
    {
      id: 'd2',
      kind: 'push',
      state: 'sent',
      attempts: 1,
      errorCode: null,
      createdAt: 4,
      finishedAt: 4,
    },
  ];
}
