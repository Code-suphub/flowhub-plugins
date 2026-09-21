export interface Container {
  id: string; name: string; image: string; state: string; status: string;
  ports: string; project: string; service: string;
}
export interface ImageSummary {
  ID: string; Repository: string; Tag: string; Size: string; CreatedSince: string;
}
export interface ListResult {context: string; containers: Container[]}
export interface ContainerDetail {
  state?: string; health?: string | null; exitCode?: number; restarts?: number; started?: string;
  mounts?: Array<{Source?: string; Destination?: string; RW?: boolean}>;
  stats?: {CPUPerc?: string; MemUsage?: string}; statsError?: string;
}
export interface ImageDetail {
  id: string; tags?: string[]; digests?: string[]; created?: string; size?: number;
  os?: string; architecture?: string; containers: Array<{id: string; name: string; state: string}>;
}
export interface StopPlan {
  context: string; targets: Array<{id: string; name: string; state: string}>;
}
export interface StopResult {
  results?: Array<{name: string; stopped: boolean; error?: string}>;
}
export type Scope = 'all' | 'compose' | 'standalone' | 'images' | 'settings';
export type Selection =
  | {kind: 'container'; id: string}
  | {kind: 'project'; project: string}
  | {kind: 'image'; id: string; reference: string}
  | {kind: 'images'};
export interface HostContext {
  preview?: boolean; title?: string; snapshot?: unknown;
  config?: {type?: string; project?: string; selection?: Selection & {context?: string}};
}
export interface ManagementApi {
  preview: boolean;
  invoke<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  dispose(): void;
}

declare global {
  interface Window {
    FlowHubPlugin?: {invoke<T>(method: string, params?: Record<string, unknown>): Promise<T>};
    FlowHubWidget?: {
      onInit(handler: (context: HostContext) => void): void;
      invoke<T>(params: {action: string; method?: string; params?: Record<string, unknown>}): Promise<T>;
    };
    FlowHubTheme?: {hosted?: boolean; get(): string; set(value: string): void};
  }
}

const samples: Container[] = [
  {id: 'a'.repeat(64), name: 'web-app-api-1', image: 'example/api:dev', state: 'restarting', status: 'Restarting (1)', ports: '127.0.0.1:8080->8080/tcp', project: 'web-app', service: 'api'},
  {id: 'b'.repeat(64), name: 'web-app-postgres-1', image: 'postgres:16', state: 'running', status: 'Up 2 hours (healthy)', ports: '127.0.0.1:5432->5432/tcp', project: 'web-app', service: 'postgres'},
  {id: 'c'.repeat(64), name: 'redis-dev', image: 'redis:7', state: 'exited', status: 'Exited (0)', ports: '', project: '', service: ''},
];
const sampleImages: ImageSummary[] = [
  {ID: 'sha256:' + 'd'.repeat(64), Repository: 'redis', Tag: '7', Size: '117MB', CreatedSince: '2 days ago'},
  {ID: 'sha256:' + 'e'.repeat(64), Repository: 'postgres', Tag: '16', Size: '432MB', CreatedSince: '5 days ago'},
];

async function previewResult<T>(method: string, params: Record<string, unknown>): Promise<T> {
  if (method === 'list') return {context: '本机 · 模拟数据', containers: samples} as T;
  if (method === 'detail') return {state: samples.find((row) => row.id === params.id)?.state, health: null, exitCode: 0, restarts: 2, started: '2026-09-10T08:00:00Z', mounts: [], stats: {CPUPerc: '2.1%', MemUsage: '128 MiB / 2 GiB'}} as T;
  if (method === 'logs') return {text: '[info] Starting application\n[error] Database connection refused\n[info] Retrying connection…'} as T;
  if (method === 'images') return {context: '本机 · 模拟数据', images: sampleImages} as T;
  if (method === 'image_detail') return {id: params.id, tags: [params.id === sampleImages[0].ID ? 'redis:7' : 'postgres:16'], digests: [], created: '2026-09-09T08:00:00Z', size: 117000000, os: 'linux', architecture: 'arm64', containers: []} as T;
  throw new Error('浏览器预览不执行操作');
}

function createTransport(host: Window, timeoutMs = 125_000) {
  const pending = new Map<string, {resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>}>();
  let disposed = false;
  function receive(event: MessageEvent) {
    if (event.source !== host.parent || event.data?.type !== 'flowhub:response') return;
    const id = String(event.data.id);
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    if (event.data.error) item.reject(new Error(String(event.data.error)));
    else item.resolve(event.data.result);
  }
  host.addEventListener('message', receive);
  return {
    invoke<T>(method: string, params: Record<string, unknown> = {}) {
      if (disposed) return Promise.reject(new Error('插件连接已关闭'));
      return new Promise<T>((resolve, reject) => {
        const id = host.crypto.randomUUID?.() ?? String(Date.now()) + '-' + Math.random();
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('宿主响应超时，请重载插件')); }, timeoutMs);
        pending.set(id, {resolve: (value) => resolve(value as T), reject, timer});
        try { host.parent.postMessage({type: 'flowhub:request', id, method, params}, '*'); }
        catch { clearTimeout(timer); pending.delete(id); reject(new Error('无法连接宿主')); }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      host.removeEventListener('message', receive);
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('插件连接已关闭'));
      }
      pending.clear();
    },
  };
}

export function createPreviewApi(): ManagementApi {
  return {preview: true, invoke: (method, params = {}) => previewResult(method, params), dispose() {}};
}

export function createApi(host: Window): ManagementApi {
  if (host.parent === host) return createPreviewApi();
  if (host.FlowHubWidget) return {preview: false, invoke: (method, params = {}) => host.FlowHubWidget!.invoke({action: 'management', method, params}), dispose() {}};
  const transport = createTransport(host);
  return {preview: false, invoke: (method, params = {}) => transport.invoke(method, params), dispose: transport.dispose};
}
