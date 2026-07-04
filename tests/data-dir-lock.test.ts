import fs from 'fs';
import os from 'os';
import path from 'path';
import ActualApiService from '../src/actual-api-service';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'actual-ai-lock-test-'));
}

function makeClient(): typeof import('@actual-app/api') {
  const asyncNoop = jest.fn(async () => Promise.resolve());
  return {
    init: asyncNoop,
    downloadBudget: asyncNoop,
    shutdown: asyncNoop,
    getCategoryGroups: jest.fn(),
    getCategories: jest.fn(),
    getPayees: jest.fn(),
    getAccounts: jest.fn(),
    getTransactions: jest.fn(),
    getRules: jest.fn(),
    getPayeeRules: jest.fn(),
    createRule: jest.fn(),
    updateTransaction: jest.fn(),
    runBankSync: jest.fn(),
    createCategory: jest.fn(),
    createCategoryGroup: jest.fn(),
    updateCategoryGroup: jest.fn(),
  } as unknown as typeof import('@actual-app/api');
}

function makeService(dataDir: string): ActualApiService {
  return new ActualApiService(
    makeClient(),
    fs,
    dataDir,
    'http://example.com',
    'pw',
    'budget',
    '',
    true,
  );
}

describe('ActualApiService dataDir lock', () => {
  test('prevents concurrent runs from sharing the same dataDir', async () => {
    const dataDir = makeTmpDir();

    const s1 = makeService(dataDir);
    const s2 = makeService(dataDir);

    await s1.initializeApi();

    await expect(s2.initializeApi()).rejects.toThrow(/Refusing to use shared dataDir/i);

    await s1.shutdownApi();

    // After the first run releases the lock, the second should be able to initialize.
    await expect(s2.initializeApi()).resolves.toBeUndefined();
    await s2.shutdownApi();
  });

  test('treats EPERM from a live pid probe as "still active", not as a permission failure', async () => {
    const dataDir = makeTmpDir();
    const lockPath = path.join(dataDir, '.actual-ai.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }),
    );

    // Simulate probing a pid that exists but is owned by another user: process.kill
    // throws EPERM, not ESRCH. That must still be read as "alive", not silently
    // downgraded to "can't write the lock file, proceed without it".
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    });

    try {
      const service = makeService(dataDir);
      await expect(service.initializeApi()).rejects.toThrow(/Refusing to use shared dataDir/i);
    } finally {
      killSpy.mockRestore();
    }
  });

  test('releaseLock() does not delete a lock this instance never held', async () => {
    const dataDir = makeTmpDir();
    const lockPath = path.join(dataDir, '.actual-ai.lock');

    const s1 = makeService(dataDir);
    const s2 = makeService(dataDir);

    await s1.initializeApi();
    await expect(s2.initializeApi()).rejects.toThrow(/Refusing to use shared dataDir/i);

    // s2 never acquired the lock; releasing it (e.g. from a SIGTERM handler) must not
    // delete s1's still-active lock.
    s2.releaseLock();
    expect(fs.existsSync(lockPath)).toBe(true);

    await s1.shutdownApi();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
