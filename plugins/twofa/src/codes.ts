import type {CodeResult} from './api';
export interface CodeEntry { code?: string; expires?: number; error?: string; retryAt?: number }

/** Codes are ephemeral: no storage or logs, and no RPC on each countdown tick. */
export class CodeCache {
  private values = new Map<string, CodeEntry>();
  private pending = new Map<string, Promise<void>>();
  private generation = 0;
  constructor(private fetchCode: (name: string) => Promise<CodeResult>, private now = Date.now) {}
  read(name: string): CodeEntry | undefined { return this.values.get(name); }
  clear() { this.generation++; this.values.clear(); this.pending.clear(); }
  ensure(name: string): Promise<void> {
    const entry = this.values.get(name);
    if ((entry?.expires ?? 0) > this.now() || (entry?.retryAt ?? 0) > this.now()) return Promise.resolve();
    const existing = this.pending.get(name);
    if (existing) return existing;
    const generation = this.generation;
    const request = (async () => {
      try {
        const started = this.now();
        const result = await Promise.resolve().then(() => this.fetchCode(name));
        if (generation !== this.generation) return;
        const period=result.period ?? 30;
        if (!/^\d{6,8}$/.test(result.code) || !Number.isInteger(period) || period<15 || period>120 || !Number.isFinite(result.remaining) || result.remaining <= 0 || result.remaining > period) throw new Error('验证码响应无效');
        this.values.set(name, {code: result.code, expires: started + result.remaining * 1000});
      } catch (error) {
        if (generation === this.generation) this.values.set(name, {error: error instanceof Error ? error.message : '验证码读取失败', retryAt: this.now() + 5000});
      } finally { if (generation === this.generation) this.pending.delete(name); }
    })();
    this.pending.set(name, request);
    return request;
  }
}

export function formatCode(code:string):string {const split=code.length===8?4:3;return code.slice(0,split)+' '+code.slice(split);}

export function filterAccounts<T extends {name: string; issuer?: string | null}>(accounts: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return accounts.filter(a => `${a.name} ${a.issuer || ''}`.toLocaleLowerCase().includes(needle));
}
