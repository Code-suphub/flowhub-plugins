export type PlatformId = "xiaohongshu" | "goofish" | "douyin";

export interface Connector {
  id: PlatformId;
  name: string;
  mode: string;
  available: boolean;
}

export interface Conversation {
  id: string;
  platform: PlatformId;
  platformName: string;
  account: string;
  title: string;
  contact: string;
  preview: string;
  unread: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  direction: "in" | "out";
  author: string;
  text: string;
  createdAt: number;
}

export interface AuthorizeParams {
  platform: "douyin";
  clientKey: string;
  redirectUri: string;
}

export interface AuthorizeResult {
  ok: boolean;
  url?: string;
  state?: string;
  reason?: string;
}

export interface SendResult {
  ok: boolean;
  reason?: string;
}

interface RpcMethods {
  health: {params: Record<string, never>; result: {protocol: number; name: string; version: string}};
  connectors: {params: Record<string, never>; result: {items: Connector[]}};
  authorize_url: {params: AuthorizeParams; result: AuthorizeResult};
  conversations: {params: {query?: string}; result: Conversation[]};
  messages: {params: {conversationId: string}; result: {conversationId: string; items: Message[]}};
  send: {params: {conversationId: string; text: string}; result: SendResult};
}

type Method = keyof RpcMethods;
type RpcParams<M extends Method> = RpcMethods[M]["params"];
type RpcResult<M extends Method> = RpcMethods[M]["result"];

interface RpcHost {
  parent: Window;
  crypto?: {
    randomUUID?: () => string;
    getRandomValues?: (array: Uint8Array) => Uint8Array;
  };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

function requestId(host: RpcHost): string {
  if (host.crypto?.randomUUID) return host.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (host.crypto?.getRandomValues) host.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One guarded listener per page; requests never outlive their timeout or page lifecycle. */
export function createTransport(host: RpcHost, timeoutMs = 125_000) {
  const pending = new Map<string, PendingRequest>();
  let disposed = false;

  function receive(event: MessageEvent): void {
    if (event.source !== host.parent || event.data?.type !== "flowhub:response") return;
    const id = event.data.id;
    if (typeof id !== "string") return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (event.data.error) entry.reject(new Error(String(event.data.error)));
    else entry.resolve(event.data.result);
  }

  host.addEventListener("message", receive);

  return {
    invoke<M extends Method>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
      if (disposed) return Promise.reject(new Error("插件连接已关闭"));
      return new Promise<RpcResult<M>>((resolve, reject) => {
        const id = requestId(host);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("宿主响应超时，请重载插件"));
        }, timeoutMs);
        pending.set(id, {resolve, reject, timer});
        try {
          host.parent.postMessage({type: "flowhub:request", id, method, params}, "*");
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error("无法连接宿主"));
        }
      });
    },
    dispose(): void {
      disposed = true;
      host.removeEventListener("message", receive);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("插件连接已关闭"));
      }
      pending.clear();
    },
  };
}

function isOfficialOAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "open.douyin.com" && url.port === "" && !url.username && !url.password && url.pathname.startsWith("/platform/oauth/connect/");
  } catch {
    return false;
  }
}

export function createApi(host: Window): SocialHubApi {
  if (host.parent === host) {
    return {
      preview: true,
      listConnectors: async () => ({items: [
        {id: "xiaohongshu", name: "小红书", mode: "演示数据", available: false},
        {id: "goofish", name: "闲鱼", mode: "通知/跳转", available: false},
        {id: "douyin", name: "抖音", mode: "待配置 Client Key", available: true},
      ]}),
      listConversations: async query => {
        const items = [{id: "preview", platform: "xiaohongshu" as const, platformName: "小红书", account: "演示账号", title: "演示会话", contact: "访客", preview: "请先配置连接器", unread: 1, updatedAt: Date.now()}];
        const needle = query?.trim().toLocaleLowerCase();
        return needle ? items.filter(item => `${item.platformName} ${item.title} ${item.contact} ${item.preview}`.toLocaleLowerCase().includes(needle)) : items;
      },
      listMessages: async conversationId => ({conversationId, items: [
        {id: "preview-in", direction: "in", author: "对方", text: "这是演示会话，请先配置连接器。", createdAt: Date.now() - 60_000},
        {id: "preview-out", direction: "out", author: "我", text: "收到。", createdAt: Date.now() - 30_000},
      ]}),
      authorize: async () => ({ok: false, reason: "浏览器预览不会生成真实授权链接"}),
      send: async () => ({ok: false, reason: "预览模式不会发送消息"}),
      dispose() {},
    };
  }

  const transport = createTransport(host as unknown as RpcHost);
  return {
    preview: false,
    listConnectors: () => transport.invoke("connectors", {}),
    listConversations: async query => {
      const result = await transport.invoke("conversations", {query: query || undefined});
      if (!Array.isArray(result)) throw new Error("会话响应无效");
      return result;
    },
    listMessages: async conversationId => {
      const result = await transport.invoke("messages", {conversationId});
      if (result.conversationId !== conversationId || !Array.isArray(result.items)) throw new Error("消息响应与会话不匹配");
      return result;
    },
    authorize: async params => {
      const result = await transport.invoke("authorize_url", params);
      if (result.ok && (!result.url || !isOfficialOAuthUrl(result.url))) {
        return {ok: false, reason: "宿主返回了非官方授权链接，已拒绝显示"};
      }
      return result;
    },
    send: (conversationId, text) => transport.invoke("send", {conversationId, text}),
    dispose: transport.dispose,
  };
}

export interface SocialHubApi {
  preview: boolean;
  listConnectors(): Promise<{items: Connector[]}>;
  listConversations(query?: string): Promise<Conversation[]>;
  listMessages(conversationId: string): Promise<{conversationId: string; items: Message[]}>;
  authorize(params: AuthorizeParams): Promise<AuthorizeResult>;
  send(conversationId: string, text: string): Promise<SendResult>;
  dispose(): void;
}

export {isOfficialOAuthUrl};
