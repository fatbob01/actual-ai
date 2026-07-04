import {
  APIAccountEntity,
  APICategoryEntity,
  APICategoryGroupEntity,
  APIPayeeEntity,
} from '@actual-app/core/src/server/api-models';
import path from 'path';
import { TransactionEntity, RuleEntity } from '@actual-app/core/src/types/models';
import { ActualApiServiceI } from './types';

function isErrnoException(error: unknown): error is Error & { code?: string } {
  return error instanceof Error;
}

class ActualApiService implements ActualApiServiceI {
  private actualApiClient: typeof import('@actual-app/api');

  private fs: typeof import('fs');

  private readonly dataDir: string;

  private readonly serverURL: string;

  private readonly password: string;

  private readonly budgetId: string;

  private readonly e2ePassword: string;

  private readonly isDryRun: boolean;

  private lockFd: number | null = null;

  private readonly lockPath: string;

  // A real classify() run should never legitimately take this long. Used as a fallback
  // for reclaiming a lock whose owning pid appears "alive" only because container
  // restarts reset the pid counter and something else now holds that same pid.
  private static readonly MAX_LOCK_AGE_MS = 6 * 60 * 60 * 1000;

  constructor(
    actualApiClient: typeof import('@actual-app/api'),
    fs: typeof import('fs'),
    dataDir: string,
    serverURL: string,
    password: string,
    budgetId: string,
    e2ePassword: string,
    isDryRun: boolean,
  ) {
    this.actualApiClient = actualApiClient;
    this.fs = fs;
    this.dataDir = dataDir;
    this.serverURL = serverURL;
    this.password = password;
    this.budgetId = budgetId;
    this.e2ePassword = e2ePassword;
    this.isDryRun = isDryRun;
    this.lockPath = path.join(this.dataDir, '.actual-ai.lock');
  }

  // A signal-0 probe throws ESRCH if the pid doesn't exist, EPERM if it exists but is
  // owned by another user, or nothing if it exists and we're allowed to signal it — the
  // latter two both mean "alive" here. Anything other than ESRCH is treated as "alive"
  // too: wrongly reclaiming a lock that's genuinely still in use (silent dataDir
  // corruption) is worse than wrongly refusing to reclaim a dead one (a clear error).
  private static isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      return !(isErrnoException(error) && error.code === 'ESRCH');
    }
  }

  // Throws if the existing lock is still legitimately held. This is a real concurrency
  // signal and must never be treated as "can't write the lock file" by the caller.
  private reclaimStaleLockIfAny(): void {
    const raw = this.fs.readFileSync(this.lockPath, 'utf8');
    let parsed: { pid?: number; startedAt?: string } | undefined;
    try {
      parsed = JSON.parse(raw) as { pid?: number; startedAt?: string };
    } catch {
      parsed = undefined;
    }

    const pid = parsed?.pid;
    if (typeof pid !== 'number') {
      // Unparseable/stale lock; remove it.
      this.fs.unlinkSync(this.lockPath);
      return;
    }

    if (!ActualApiService.isPidAlive(pid)) {
      // Stale lock from a crashed process; remove it.
      this.fs.unlinkSync(this.lockPath);
      return;
    }

    const startedAtMs = parsed?.startedAt ? Date.parse(parsed.startedAt) : NaN;
    const isTooOld = Number.isFinite(startedAtMs)
      && Date.now() - startedAtMs > ActualApiService.MAX_LOCK_AGE_MS;

    if (isTooOld) {
      // The pid looks "alive", but container restarts reset pid counters, so an
      // unrelated process may have been assigned the same pid. A lock this old is
      // never legitimate, so reclaim it rather than blocking forever.
      console.warn(
        `dataDir lock at ${this.lockPath} is held by pid=${pid} but is older than `
        + `${ActualApiService.MAX_LOCK_AGE_MS / 3_600_000}h. Assuming it is stale `
        + '(likely leftover from a container restart that reused this pid) and reclaiming it.',
      );
      this.fs.unlinkSync(this.lockPath);
      return;
    }

    throw new Error(
      `Another actual-ai run appears active (pid=${pid}). `
      + `Refusing to use shared dataDir: ${this.dataDir}`,
    );
  }

  private failOpenOnPermissionError(error: unknown): boolean {
    if (!isErrnoException(error) || (error.code !== 'EACCES' && error.code !== 'EPERM')) {
      return false;
    }

    // Not a concurrency signal — the environment (e.g. a misconfigured tmpfs mount)
    // won't let us write the lock at all. Don't block classification over it; just
    // lose the concurrent-run protection and say why.
    console.warn(
      `Could not acquire dataDir lock at ${this.lockPath} (${error.code}: permission denied). `
      + 'Continuing without the lock, so concurrent runs sharing this dataDir will not be '
      + `detected. Check that the container user can write to ${this.dataDir} `
      + '(e.g. drop any custom tmpfs mount on that path, or grant it write access).',
    );
    this.lockFd = null;
    return true;
  }

  private acquireDataDirLock() {
    // Prevent multiple concurrent runs from sharing the same dataDir. The underlying
    // Actual sqlite DB is not safe for concurrent writers and can end up "out-of-sync".
    try {
      if (!this.fs.existsSync(this.dataDir)) {
        this.fs.mkdirSync(this.dataDir, { recursive: true });
      }
    } catch (error) {
      if (this.failOpenOnPermissionError(error)) return;
      throw error instanceof Error ? error : new Error('Failed to create dataDir');
    }

    if (this.fs.existsSync(this.lockPath)) {
      // Deliberately outside the try/catch below: an error here (including the
      // "still active" throw, or a probe failure) is a real concurrency signal, not
      // an "environment can't write the lock file" situation, and must propagate.
      this.reclaimStaleLockIfAny();
    }

    try {
      // 'wx' creates exclusively; throws if exists.
      this.lockFd = this.fs.openSync(this.lockPath, 'wx');
      this.fs.writeFileSync(
        this.lockFd,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
    } catch (error) {
      if (this.failOpenOnPermissionError(error)) return;
      throw error instanceof Error ? error : new Error('Failed to acquire dataDir lock');
    }
  }

  private releaseDataDirLock() {
    // Only ever unlink a lock this instance actually opened. Without this check, a
    // process that never held the lock (e.g. one that lost dataDir contention to
    // another process legitimately sharing the same volume) could delete that other
    // process's still-valid lock — most easily reached via releaseLock() below, which
    // a signal handler can call at any time regardless of whether this instance is
    // mid-run or ever acquired the lock in the first place.
    const heldLock = this.lockFd !== null;
    try {
      if (this.lockFd !== null) {
        this.fs.closeSync(this.lockFd);
        this.lockFd = null;
      }
      if (heldLock && this.fs.existsSync(this.lockPath)) {
        this.fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  // Public, synchronous, best-effort. Intended for use from process signal handlers
  // (e.g. SIGTERM on `docker restart`) where we can't rely on in-flight async work
  // running its normal finally/shutdown path before the process exits.
  public releaseLock(): void {
    this.releaseDataDirLock();
  }

  public async initializeApi() {
    this.acquireDataDirLock();

    await this.actualApiClient.init({
      dataDir: this.dataDir,
      serverURL: this.serverURL,
      password: this.password,
    });

    try {
      if (this.e2ePassword) {
        await this.actualApiClient.downloadBudget(this.budgetId, {
          password: this.e2ePassword,
        });
      } else {
        await this.actualApiClient.downloadBudget(this.budgetId);
      }
      console.log('Budget downloaded');
    } catch (error: unknown) {
      let errorMessage = 'Failed to download budget';
      if (error instanceof Error) {
        errorMessage += `: ${error.message}`;
        if ('status' in error && typeof error.status === 'number') {
          errorMessage += ` (HTTP ${error.status})`;
        }
      }
      console.error(errorMessage);
      console.error('Full error details:', error);

      await this.actualApiClient.shutdown();
      this.releaseDataDirLock();

      throw new Error(`Budget download failed. Verify that:
1. Budget ID "${this.budgetId}" is correct
2. Server URL "${this.serverURL}" is reachable
3. Password is correct
4. E2E password (if used) is valid`);
    }
  }

  public async shutdownApi() {
    await this.actualApiClient.shutdown();
    this.releaseDataDirLock();
  }

  public async getCategoryGroups(): Promise<APICategoryGroupEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.actualApiClient.getCategoryGroups();
  }

  public async getCategories(): Promise<(APICategoryEntity | APICategoryGroupEntity)[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.actualApiClient.getCategories();
  }

  public async getPayees(): Promise<APIPayeeEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.actualApiClient.getPayees();
  }

  public async getAccounts(): Promise<APIAccountEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.actualApiClient.getAccounts();
  }

  public async getTransactions(): Promise<TransactionEntity[]> {
    let transactions: TransactionEntity[] = [];
    const accounts = await this.getAccounts();
    // eslint-disable-next-line no-restricted-syntax
    for (const account of accounts) {
      transactions = transactions.concat(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await this.actualApiClient.getTransactions(account.id, '1990-01-01', '2030-01-01'),
      );
    }
    return transactions;
  }

  public async getRules(): Promise<RuleEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.actualApiClient.getRules();
  }

  public async getPayeeRules(payeeId: string): Promise<RuleEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.actualApiClient.getPayeeRules(payeeId);
  }

  public async updateTransactionNotes(id: string, notes: string): Promise<void> {
    if (this.isDryRun) {
      console.log(`DRY RUN: Would update transaction notes of ${id} to: ${notes}`);
      return;
    }
    await this.actualApiClient.updateTransaction(id, { notes });
  }

  public async updateTransactionNotesAndCategory(
    id: string,
    notes: string,
    categoryId: string,
  ): Promise<void> {
    if (this.isDryRun) {
      console.log(`DRY RUN: Would update transaction notes ${id} to: ${notes} and category to ${categoryId}`);
      return;
    }
    await this.actualApiClient.updateTransaction(id, { notes, category: categoryId });
  }

  public async runBankSync(accountId?: string): Promise<void> {
    if (this.isDryRun) {
      console.log(`DRY RUN: Would run bank sync${accountId ? ` for account ${accountId}` : ''}`);
      return;
    }
    await this.actualApiClient.runBankSync(accountId ? { accountId } : undefined);
  }

  public async createCategory(name: string, groupId: string): Promise<string> {
    if (this.isDryRun) {
      console.log(`DRY RUN: Would create category name: ${name} groupId: ${groupId}`);
      return 'dry run';
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.actualApiClient.createCategory({
      name,
      group_id: groupId,
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return result;
  }

  public async createCategoryGroup(name: string): Promise<string> {
    if (this.isDryRun) {
      console.log(`DRY RUN: Would create category group: ${name}`);
      return 'dry run';
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.actualApiClient.createCategoryGroup({
      name,
    });
  }

  public async updateCategoryGroup(id: string, name: string): Promise<void> {
    if (this.isDryRun) {
      console.log(`DRY RUN: Would update category group name: ${name} groupId: ${id}`);
      return;
    }
    await this.actualApiClient.updateCategoryGroup(id, { name });
  }
}

export default ActualApiService;
