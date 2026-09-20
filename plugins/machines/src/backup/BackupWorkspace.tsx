import { useRef, useState } from 'react';
import { Button, DialogShell, Field, HelpPopover, Input, Tabs } from '@flowhub/plugin-common/react';
import './styles.css';

type Action = 'backup' | 'export' | 'inspect' | 'restore';
interface Summary { created: string; machines: number; files: number; hasPasswords: boolean; hasHistory: boolean }
interface Result { canceled?: boolean; path?: string; token?: string; summary?: Summary; rollback?: string }
export type BackupApi = (action: Action, password: string, token: string | null) => Promise<Result>;

export function BackupWorkspace({ api }: { api: BackupApi | null }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('backup');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [preview, setPreview] = useState<{ token: string; summary: Summary } | null>(null);
  const [status, setStatus] = useState<{ error: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const pending = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  function clearCredentials() { setPassword(''); setRepeat(''); setPreview(null); }
  function changeOpen(next: boolean) {
    if (pending.current) return;
    clearCredentials();
    if (!restartRequired) setStatus(null);
    setMode('backup');
    setOpen(next);
  }
  function changeMode(next: string) {
    if (pending.current || restartRequired) return;
    clearCredentials(); setStatus(null); setMode(next);
  }

  async function run(action: Action) {
    if (!api || pending.current || restartRequired) return;
    if (action === 'restore' && !preview) return;
    if (action !== 'restore' && password.length < 12) {
      setStatus({ error: true, message: '请输入至少 12 个字符的备份口令。' }); passwordRef.current?.focus(); return;
    }
    if ((action === 'backup' || action === 'export') && password !== repeat) {
      setStatus({ error: true, message: '两次口令不一致。' }); return;
    }
    const token = preview?.token ?? null;
    // A new inspection invalidates the previous confirmation, even if file selection is cancelled.
    if (action === 'inspect' || action === 'restore') setPreview(null);
    pending.current = true; setBusy(true); setStatus({ error: false, message: '正在处理…' });
    try {
      const result = await api(action, password, token);
      if (result.canceled) { setStatus({ error: false, message: '已取消' }); return; }
      if (action === 'inspect') {
        if (!result.token || !result.summary) throw new Error('备份校验结果不完整，请重新选择文件。');
        setPreview({ token: result.token, summary: result.summary });
        setStatus({ error: false, message: '校验通过，请核对备份后确认恢复。' });
      } else if (action === 'restore') {
        clearCredentials(); setRestartRequired(true);
        setStatus({ error: false, message: `恢复已准备好，请到插件市场重新加载机器插件。${result.rollback ? '\n原数据回退位置：' + result.rollback : ''}` });
      } else {
        clearCredentials();
        setStatus({ error: false, message: `加密备份已保存：${result.path ?? ''}` });
      }
    } catch (reason) {
      setStatus({ error: true, message: String(reason instanceof Error ? reason.message : reason).replace(/^(?:Error:\s*)+/, '') });
    } finally { pending.current = false; setBusy(false); }
  }

  const disabled = busy || restartRequired;
  return <>
    <Button id="openBackup" variant="secondary" disabled={!api} onClick={() => changeOpen(true)}>备份与恢复</Button>
    <DialogShell open={open} onOpenChange={changeOpen} title="备份与恢复" initialFocusRef={passwordRef}
      className="backup-workspace" contentClassName="backup-workspace__shell"
      onCancel={(event) => { if (pending.current) event.preventDefault(); }}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={() => changeOpen(false)}>关闭</Button>
        {mode === 'backup' ? <>
          <Button variant="secondary" disabled={disabled} onClick={() => void run('export')}>导出备份文件</Button>
          <Button variant="primary" disabled={disabled} onClick={() => void run('backup')}>创建本地备份</Button>
        </> : preview ? <Button variant="primary" disabled={disabled} onClick={() => void run('restore')}>确认恢复并替换</Button>
          : <Button variant="primary" disabled={disabled} onClick={() => void run('inspect')}>选择备份文件</Button>}
      </>}>
      <div className="backup-workspace__heading">
        <Tabs value={mode} onValueChange={changeMode}>
          <Tabs.List aria-label="备份操作">
            <Tabs.Trigger value="backup" disabled={disabled}>创建备份</Tabs.Trigger>
            <Tabs.Trigger value="restore" disabled={disabled}>恢复备份</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Panel value={mode}>
            <div className="backup-workspace__fields" aria-busy={busy}>
              <Field label="备份口令" htmlFor="backup-password">
                <Input ref={passwordRef} id="backup-password" type="password" autoComplete="new-password" value={password} disabled={disabled}
                  placeholder="至少 12 个字符" onChange={(event) => { setPassword(event.currentTarget.value); setPreview(null); setStatus(null); }} />
              </Field>
              {mode === 'backup' ? <Field label="确认口令" htmlFor="backup-repeat">
                <Input id="backup-repeat" type="password" autoComplete="new-password" value={repeat} disabled={disabled}
                  placeholder="再次输入备份口令" onChange={(event) => setRepeat(event.currentTarget.value)} />
              </Field> : null}
              {preview ? <section className="backup-workspace__preview" aria-label="待恢复备份">
                <dl>
                  <dt>备份时间</dt><dd>{preview.summary.created}</dd>
                  <dt>机器 / 文件</dt><dd>{preview.summary.machines} 台 / {preview.summary.files} 个</dd>
                  <dt>密码 / 执行记录</dt><dd>{preview.summary.hasPasswords ? '包含' : '无'} / {preview.summary.hasHistory ? '包含' : '无'}</dd>
                </dl>
                <p>恢复将替换当前插件数据，原数据保留为回退副本。恢复后后台监控保持关闭。</p>
                <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void run('inspect')}>重新选择文件</Button>
              </section> : null}
              {status ? <p className="backup-workspace__status" role={status.error ? 'alert' : 'status'} data-error={status.error}>{status.message}</p> : null}
            </div>
          </Tabs.Panel>
        </Tabs>
        <HelpPopover label="备份与恢复说明" className="backup-workspace__help">
          配置、执行记录、密码数据库和密钥一起加密打包。备份口令用于跨设备恢复，请妥善保存。
          私钥文件、relay 脚本和本机 SSH 配置不包含在内。
        </HelpPopover>
      </div>
    </DialogShell>
  </>;
}
