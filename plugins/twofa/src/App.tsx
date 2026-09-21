import {useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {Button, DialogShell, DropdownMenu, EmptyState, Field, HelpPopover, Input} from '@flowhub/plugin-common/react';
import type {Account, TwofaApi} from './api';
import {CodeCache, filterAccounts} from './codes';

const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

function AccountList({accounts, cache, onEdit, onRemove, notify}: {
  accounts: Account[]; cache: CodeCache; onEdit(account: Account): void; onRemove(account: Account): void; notify(text: string): void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let cancelled = false, running = false;
    async function tick() {
      if (document.hidden) return;
      setNow(Date.now());
      if (running) return;
      running = true;
      try {
        // Bound independent requests to avoid flooding the host on large lists.
        for (let i = 0; i < accounts.length && !cancelled; i += 4) {
          await Promise.all(accounts.slice(i, i + 4).map(account => cache.ensure(account.name)));
          if (!cancelled) setNow(Date.now());
        }
      } finally { running = false; }
    }
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [accounts, cache]);

  function copy(name: string) {
    const entry = cache.read(name);
    if (!entry?.code || (entry.expires ?? 0) <= Date.now()) { notify('验证码已过期，正在刷新'); return; }
    // Keep the clipboard request within the user gesture (important for WebKit).
    if (!navigator.clipboard?.writeText) { notify('当前环境不支持复制，请选中验证码手动复制。'); return; }
    void navigator.clipboard.writeText(entry.code).then(() => notify('验证码已复制'), () => notify('无法复制，请选中验证码手动复制。'));
  }
  return <ul className="m-0 list-none p-0" aria-label="验证器账户">
    {accounts.map(account => {
      const entry = cache.read(account.name);
      const remaining = Math.max(0, Math.ceil(((entry?.expires ?? 0) - now) / 1000));
      const code = remaining ? entry?.code : undefined;
      return <li key={account.name} className="account-row">
        <div className="account-identity grid min-w-0 gap-1">
          <strong className="break-words text-sm">{account.name}</strong>
          {account.issuer ? <span className="muted break-words text-xs">{account.issuer}</span> : null}
        </div>
        <div className="grid min-w-0 gap-1">
          <span className="token-code" aria-label={`${account.name}验证码`}>{code?.replace(/^(\d{3})(\d{3})$/, '$1 $2') || '··· ···'}</span>
          <span className={`text-xs ${entry?.error ? 'error' : 'muted'}`}>{entry?.error || (remaining ? `${remaining} 秒` : '刷新中')}</span>
        </div>
        <Button size="sm" disabled={!code} aria-label={`复制 ${account.name} 验证码`} onClick={() => copy(account.name)}>复制</Button>
        <DropdownMenu label="•••" ariaLabel={`${account.name}更多操作`} items={[
          {id: 'edit', label: '编辑', onSelect: () => onEdit(account)},
          {id: 'remove', label: '删除', danger: true, onSelect: () => onRemove(account)}
        ]}/>
      </li>;
    })}
  </ul>;
}

function Editor({account, accounts, api, onClose, onSaved}: {
  account: Account | null; accounts: Account[]; api: TwofaApi; onClose(): void; onSaved(): Promise<void>;
}) {
  const [name, setName] = useState(account?.name || '');
  const [issuer, setIssuer] = useState(account?.issuer || '');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmedName = name.trim();
    if (!trimmedName) { setError('请输入账户名称'); return; }
    if (accounts.some(a => a.name === trimmedName && a.name !== account?.name)) { setError('该名称已存在，请使用其他名称'); return; }
    setBusy(true); setError('');
    try {
      await api.save({name: trimmedName, issuer: issuer.trim() || null, secret: secret.trim(), ...(account ? {previous: account.name} : {})});
      setSecret(''); await onSaved(); onClose();
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  return <DialogShell open onOpenChange={open => { if (!open && !busy) { setSecret(''); onClose(); } }}
    onCancel={event => { if (busy) event.preventDefault(); }}
    title={account ? '编辑账户' : '添加账户'} initialFocusRef={nameRef} className="twofa-dialog"
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="account-form" disabled={busy}>{busy ? '保存中…' : '保存'}</Button></>}>
    <form id="account-form" onSubmit={save} className="grid gap-4">
      <Field label="名称" htmlFor="account-name"><Input id="account-name" ref={nameRef} required maxLength={80} value={name} onChange={e => setName(e.target.value)} disabled={busy}/></Field>
      <Field label="发行方（可选）" htmlFor="account-issuer"><Input id="account-issuer" maxLength={120} value={issuer} onChange={e => setIssuer(e.target.value)} disabled={busy}/></Field>
      <Field label={<span className="inline-flex items-center gap-2">Base32 密钥<HelpPopover label="密钥说明">支持标准 Base32 TOTP 密钥；编辑时留空保留原密钥。密钥仅交给本机后端保存，不写入浏览器存储。</HelpPopover></span>} htmlFor="account-secret">
        <Input id="account-secret" type="password" autoComplete="new-password" spellCheck={false} required={!account} value={secret} onChange={e => setSecret(e.target.value)} placeholder={account ? '留空保留原密钥' : '输入 Base32 密钥'} disabled={busy}/>
      </Field>
      {api.preview ? <p className="muted m-0 text-xs">模拟预览：不会保存真实账户。</p> : null}
      {error ? <p className="error m-0 text-sm" role="alert">{error}</p> : null}
    </form>
  </DialogShell>;
}

export function App({api}: {api: TwofaApi}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [query, setQuery] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('');
  const [editor, setEditor] = useState<{account: Account | null} | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState('');
  const [revision, setRevision] = useState(0);
  const cache = useMemo(() => new CodeCache(name => api.code(name)), [api, revision]);
  useEffect(() => () => cache.clear(), [cache]);
  useEffect(() => {
    let active = true;
    setLoading(true); setLoadError('');
    api.list().then(result => { if (active) setAccounts(result); }, error => { if (active) setLoadError(message(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, revision]);
  const visible = useMemo(() => filterAccounts(accounts, query), [accounts, query]);
  async function saved() { setNotice('账户已保存'); setRevision(v => v + 1); }
  async function remove() {
    if (!removing || deleting) return;
    setDeleting(true); setDeleteError('');
    try { await api.remove(removing.name); setRemoving(null); setNotice('账户已删除'); setRevision(v => v + 1); }
    catch (error) { setDeleteError(message(error)); }
    finally { setDeleting(false); }
  }
  return <main className="twofa">
    <header className="mb-4 flex flex-wrap items-center gap-2">
      {api.preview ? <h1 className="m-0 text-lg font-semibold">2FA 验证码</h1> : <span className="text-sm font-semibold">账户</span>}
      <HelpPopover label="验证码说明">输入名称或发行方过滤账户。验证码到期自动刷新；密钥保存在本机加密文件中。</HelpPopover>
      <span className="muted text-xs">{visible.length} / {accounts.length}</span>
      <Button className="ml-auto" onClick={() => setEditor({account: null})}>添加账户</Button>
    </header>
    <Input type="search" className="search-input" aria-label="搜索账户" placeholder="搜索名称或发行方" value={query} onChange={event => setQuery(event.target.value)}/>
    {notice ? <p role="status" className="muted my-3 text-sm">{notice}</p> : null}
    {loading ? <p role="status" className="muted text-sm">加载账户中…</p>
      : loadError ? <div role="alert" className="my-4 flex items-center gap-3"><span className="error text-sm">{loadError}</span><Button onClick={() => setRevision(v => v + 1)}>重试</Button></div>
      : visible.length ? <AccountList accounts={visible} cache={cache} onEdit={account => setEditor({account})} onRemove={account => {setRemoving(account); setDeleteError('');}} notify={setNotice}/>
      : <EmptyState size="compact" className="twofa-empty" title={accounts.length ? '没有匹配的账户' : '暂无账户'}/>}
    {editor ? <Editor account={editor.account} accounts={accounts} api={api} onClose={() => setEditor(null)} onSaved={saved}/> : null}
    <DialogShell open={Boolean(removing)} onOpenChange={open => { if (!open && !deleting) setRemoving(null); }} onCancel={event => {if (deleting) event.preventDefault();}}
      title="删除账户" className="twofa-dialog" footer={<><Button disabled={deleting} onClick={() => setRemoving(null)}>取消</Button><Button variant="danger" disabled={deleting} onClick={() => void remove()}>{deleting ? '删除中…' : '删除'}</Button></>}>
      <p className="m-0 break-words text-sm leading-6">删除「{removing?.name}」后，需要重新添加密钥才能生成验证码。此操作无法撤销。</p>
      {deleteError ? <p role="alert" className="error text-sm">{deleteError}</p> : null}
    </DialogShell>
  </main>;
}
