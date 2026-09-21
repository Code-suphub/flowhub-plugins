import {useEffect, useMemo, useRef, useState, type FormEvent} from "react";
import {Button, DialogShell, EmptyState, Field, HelpPopover, Input, Textarea} from "@flowhub/plugin-common/react";
import type {AuthorizeParams, Connector, Conversation, Message, SocialHubApi} from "./api";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试";

function ConnectorStatus({connectors, onAuthorize}: {connectors: Connector[]; onAuthorize(): void}) {
  return <section className="social-hub__connector-strip" aria-labelledby="connector-heading">
    <div className="social-hub__section-heading">
      <h2 id="connector-heading">平台状态</h2>
      <HelpPopover label="连接器说明">当前页面只读取后端提供的连接器状态。未授权的平台不会拉取真实账号数据，也不会发送消息；抖音这里只生成官方 OAuth 链接。</HelpPopover>
    </div>
    <div className="social-hub__connector-grid">
      {connectors.map(connector => <div className="social-hub__connector" key={connector.id}>
        <div className="social-hub__connector-mark" aria-hidden="true">{connector.name.slice(0, 1)}</div>
        <div className="min-w-0">
          <strong>{connector.name}</strong>
          <span className="social-hub__muted">未授权 · {connector.mode}</span>
        </div>
        {connector.id === "douyin" ? <Button size="sm" className="ml-auto" onClick={onAuthorize}>配置</Button> : null}
      </div>)}
    </div>
  </section>;
}

function ConversationList({items, selectedId, onSelect}: {items: Conversation[]; selectedId: string | null; onSelect(id: string): void}) {
  return <div className="social-hub__conversation-list" aria-label="会话列表">
    {items.length ? items.map(conversation => <button
      type="button"
      className={`social-hub__conversation ${selectedId === conversation.id ? "is-selected" : ""}`}
      key={conversation.id}
      aria-pressed={selectedId === conversation.id}
      onClick={() => onSelect(conversation.id)}
    >
      <span className="social-hub__conversation-topline">
        <strong>{conversation.contact}</strong>
        {conversation.unread ? <span className="social-hub__unread" aria-label={`${conversation.unread} 条未读`}>{conversation.unread}</span> : null}
      </span>
      <span className="social-hub__conversation-title">{conversation.platformName} · {conversation.title}</span>
      <span className="social-hub__conversation-preview">{conversation.preview}</span>
      <span className="social-hub__conversation-meta">{conversation.account} · 演示会话</span>
    </button>) : <EmptyState size="compact" title="暂无匹配会话" description="可以换一个联系人或内容关键词。"/>}
  </div>;
}

function MessageThread({messages}: {messages: Message[]}) {
  if (!messages.length) return <p className="social-hub__muted social-hub__thread-empty">暂无消息</p>;
  return <div className="social-hub__thread" aria-live="polite">
    {messages.map(message => <article className={`social-hub__message ${message.direction === "out" ? "is-out" : ""}`} key={message.id}>
      <span className="social-hub__message-author">{message.author}</span>
      <p>{message.text}</p>
    </article>)}
  </div>;
}

function AuthorizeDialog({api, open, onClose, onNotice}: {api: SocialHubApi; open: boolean; onClose(): void; onNotice(text: string): void}) {
  const [clientKey, setClientKey] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const clientKeyRef = useRef<HTMLInputElement>(null);

  function close(): void {
    if (busy) return;
    setError("");
    setResultUrl("");
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const params: AuthorizeParams = {platform: "douyin", clientKey: clientKey.trim(), redirectUri: redirectUri.trim()};
    if (!params.clientKey || !params.redirectUri) {
      setError("请填写 Client Key 和回调地址");
      return;
    }
    setBusy(true);
    setError("");
    setResultUrl("");
    try {
      const result = await api.authorize(params);
      if (!result.ok || !result.url) {
        setError(result.reason || "未生成授权链接；连接器仍未授权");
        return;
      }
      setResultUrl(result.url);
      onNotice("已生成官方授权链接；不会自动打开或完成授权。");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return <DialogShell open={open} onOpenChange={nextOpen => {if (!nextOpen) close();}} onCancel={event => {if (busy) event.preventDefault();}}
    title="抖音官方 OAuth" description="只生成链接，不自动打开、不保存凭证，也不会在此页面完成授权。" initialFocusRef={clientKeyRef} className="social-hub__dialog"
    footer={<><Button disabled={busy} onClick={close}>取消</Button><Button variant="primary" type="submit" form="social-oauth-form" disabled={busy}>{busy ? "生成中…" : "生成官方链接"}</Button></>}>
    <form id="social-oauth-form" className="grid gap-4" onSubmit={submit}>
      <Field label={<span className="inline-flex items-center gap-2">Client Key<HelpPopover label="Client Key 说明">仅作为授权请求参数传给本机后端，不写入浏览器存储。</HelpPopover></span>} htmlFor="social-client-key">
        <Input id="social-client-key" ref={clientKeyRef} autoComplete="off" value={clientKey} onChange={event => setClientKey(event.target.value)} disabled={busy}/>
      </Field>
      <Field label={<span className="inline-flex items-center gap-2">回调地址<HelpPopover label="回调地址说明">请填写你已在抖音开发者平台登记的 HTTPS 地址。</HelpPopover></span>} htmlFor="social-redirect-uri">
        <Input id="social-redirect-uri" type="url" inputMode="url" placeholder="https://example.com/callback" value={redirectUri} onChange={event => setRedirectUri(event.target.value)} disabled={busy}/>
      </Field>
      {resultUrl ? <div className="social-hub__oauth-result" role="status">
        <strong>官方链接已生成</strong>
        <span>请由你主动打开；生成链接不代表已授权。</span>
        <a href={resultUrl} target="_blank" rel="noopener noreferrer">在浏览器中打开 open.douyin.com</a>
      </div> : null}
      {api.preview ? <p className="social-hub__muted m-0 text-xs">浏览器预览为只读模拟，不会生成真实链接。</p> : null}
      {error ? <p className="social-hub__error m-0" role="alert">{error}</p> : null}
    </form>
  </DialogShell>;
}

export function App({api}: {api: SocialHubApi}) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [threadError, setThreadError] = useState("");
  const [notice, setNotice] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [authorizeOpen, setAuthorizeOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    Promise.all([api.listConnectors(), api.listConversations(query)])
      .then(([connectorResult, conversationResult]) => {
        if (!active) return;
        setConnectors(connectorResult.items);
        setConversations(conversationResult);
        setSelectedId(current => current && conversationResult.some(item => item.id === current) ? current : conversationResult[0]?.id ?? null);
      })
      .catch(error => {if (active) setLoadError(errorMessage(error));})
      .finally(() => {if (active) setLoading(false);});
    return () => {active = false;};
  }, [api, query, refreshKey]);

  const selected = useMemo(() => conversations.find(item => item.id === selectedId) ?? null, [conversations, selectedId]);
  const draft = selectedId ? drafts[selectedId] ?? "" : "";
  const sendError = selectedId ? sendErrors[selectedId] ?? "" : "";

  useEffect(() => {
    setMessages([]);
    setThreadError("");
    setMessagesLoading(Boolean(selected));
    if (!selected) {
      return;
    }
    let active = true;
    api.listMessages(selected.id)
      .then(result => {if (active) setMessages(result.items);})
      .catch(error => {if (active) setThreadError(errorMessage(error));})
      .finally(() => {if (active) setMessagesLoading(false);});
    return () => {active = false;};
  }, [api, selected]);

  async function send(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected || sending) return;
    const conversationId = selected.id;
    const text = draft.trim();
    if (!text) {
      setSendErrors(current => ({...current, [conversationId]: "请输入回复内容"}));
      return;
    }
    setSending(true);
    setSendErrors(current => ({...current, [conversationId]: ""}));
    try {
      const result = await api.send(conversationId, text);
      if (result.ok) {
        setDrafts(current => ({...current, [conversationId]: ""}));
        setNotice("消息已发送");
      } else {
        setSendErrors(current => ({...current, [conversationId]: result.reason || "连接器未授权，消息未发送；草稿已保留"}));
      }
    } catch (error) {
      setSendErrors(current => ({...current, [conversationId]: `${errorMessage(error)}；草稿已保留`}));
    } finally {
      setSending(false);
    }
  }

  return <main className="social-hub">
    <header className="social-hub__header">
      <div className="min-w-0">
        <h1>社交聚合</h1>
      </div>
      <div className="social-hub__header-actions">
        <span className="social-hub__demo-pill"><span aria-hidden="true">●</span> 演示数据 · 未授权</span>
        <HelpPopover label="页面安全边界">会话和消息来自当前后端的演示接口。页面不持久化账号、Client Key、Token 或密钥，也不会自动打开 OAuth 或执行真实发送。</HelpPopover>
        <Button onClick={() => setRefreshKey(value => value + 1)} disabled={loading}>刷新</Button>
      </div>
    </header>

    {notice ? <p className="social-hub__notice" role="status">{notice}</p> : null}
    {loadError ? <div className="social-hub__error-banner" role="alert"><span>{loadError}</span><Button size="sm" onClick={() => setRefreshKey(value => value + 1)}>重试</Button></div> : null}
    <ConnectorStatus connectors={connectors} onAuthorize={() => setAuthorizeOpen(true)}/>

    <section className="social-hub__workspace" aria-label="社交会话工作台">
      <section className="social-hub__panel social-hub__inbox" aria-labelledby="conversation-heading">
        <div className="social-hub__section-heading">
          <div><h2 id="conversation-heading">会话 <span className="social-hub__count">{conversations.length}</span></h2></div>
          <HelpPopover label="会话列表说明">列表支持按联系人、平台和消息摘要过滤。当前数据是演示数据，未代表任何已接入的真实平台账号。</HelpPopover>
        </div>
        <Input type="search" aria-label="搜索会话" placeholder="搜索联系人或内容" value={query} onChange={event => setQuery(event.target.value)}/>
        <div className="social-hub__list-state">{loading ? "正在读取演示会话…" : `${conversations.length} 个会话`}</div>
        <ConversationList items={conversations} selectedId={selectedId} onSelect={id => {setSelectedId(id); setSendErrors(current => ({...current, [id]: ""}));}}/>
      </section>

      <section className="social-hub__panel social-hub__conversation-panel" aria-labelledby="thread-heading">
        {selected ? <>
          <div className="social-hub__thread-header">
            <div className="min-w-0"><h2 id="thread-heading">{selected.title}</h2><p className="social-hub__muted">{selected.platformName} · {selected.contact} · {selected.account} · 演示会话</p></div>
            <span className="social-hub__unauthed-label">未授权</span>
          </div>
          <div className="social-hub__thread-body">
            {messagesLoading ? <p className="social-hub__muted">正在读取消息…</p> : threadError ? <p className="social-hub__error" role="alert">{threadError}</p> : <MessageThread messages={messages}/>}
          </div>
          <form className="social-hub__composer" onSubmit={send}>
            <Field label={<span className="inline-flex items-center gap-2">回复草稿<HelpPopover label="回复安全说明">发送接口当前会返回“未授权”失败。失败时草稿不会清空。</HelpPopover></span>} htmlFor="social-reply">
              <Textarea id="social-reply" rows={3} value={draft} onChange={event => {if (selectedId) setDrafts(current => ({...current, [selectedId]: event.target.value})); if (sendError && selectedId) setSendErrors(current => ({...current, [selectedId]: ""}));}} placeholder="输入回复（当前仅保留草稿，不会实际送出）" disabled={sending}/>
            </Field>
            <div className="social-hub__composer-actions"><span className="social-hub__muted">发送前仍需完成连接器授权</span><Button variant="primary" type="submit" disabled={sending || !draft.trim()}>{sending ? "发送中…" : "发送"}</Button></div>
            {sendError ? <p className="social-hub__error" role="alert">{sendError}</p> : null}
          </form>
        </> : <EmptyState title="选择一个会话" description="从左侧演示会话列表选择一项查看消息。"/>}
      </section>
    </section>
    <AuthorizeDialog api={api} open={authorizeOpen} onClose={() => setAuthorizeOpen(false)} onNotice={setNotice}/>
  </main>;
}
