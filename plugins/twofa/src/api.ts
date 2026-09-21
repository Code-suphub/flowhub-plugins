export interface Account { name: string; issuer?: string | null }
export interface CodeResult { name: string; code: string; remaining: number }
export interface SaveAccount extends Account { secret: string; previous?: string }
export interface TwofaApi {
  preview: boolean;
  list(): Promise<Account[]>;
  code(name: string): Promise<CodeResult>;
  save(account: SaveAccount): Promise<void>;
  remove(name: string): Promise<void>;
  dispose(): void;
}

/** One listener per page; only the embedding host may resolve RPC requests. */
export function createTransport(host: Window, timeoutMs = 125_000) {
  const pending = new Map<string, {resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>}>();
  let disposed = false;
  function receive(event: MessageEvent) {
    if (event.source !== host.parent || event.data?.type !== 'flowhub:response') return;
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id); clearTimeout(entry.timer);
    if (event.data.error) entry.reject(new Error(String(event.data.error)));
    else entry.resolve(event.data.result);
  }
  host.addEventListener('message', receive);
  return {
    invoke<T>(method: string, params: object = {}): Promise<T> {
      if (disposed) return Promise.reject(new Error('插件连接已关闭'));
      return new Promise((resolve, reject) => {
        const id = host.crypto.randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('宿主响应超时，请重载插件')); }, timeoutMs);
        pending.set(id, {resolve: value => resolve(value as T), reject, timer});
        try { host.parent.postMessage({type: 'flowhub:request', id, method, params}, '*'); }
        catch { pending.delete(id); clearTimeout(timer); reject(new Error('无法连接宿主')); }
      });
    },
    dispose() {
      disposed = true; host.removeEventListener('message', receive);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('插件连接已关闭')); }
      pending.clear();
    }
  };
}

export function createApi(host: Window): TwofaApi {
  if (host.parent === host) {
    const readonly = async () => { throw new Error('浏览器预览不保存或删除真实账户'); };
    return {
      preview: true,
      list: async () => [{name: '示例账户', issuer: '模拟数据'}],
      code: async name => ({name, code: '123456', remaining: 30 - Math.floor(Date.now() / 1000) % 30}),
      save: readonly, remove: readonly, dispose() {}
    };
  }
  const transport = createTransport(host);
  return {
    preview: false,
    list: async () => (await transport.invoke<{accounts: Account[]}>('list')).accounts,
    code: name => transport.invoke('code', {name}),
    save: async payload => { await transport.invoke('save', payload); },
    remove: async name => { await transport.invoke('remove', {name}); },
    dispose: transport.dispose
  };
}
