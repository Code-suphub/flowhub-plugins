import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Select } from '@flowhub/plugin-common/react';
import type { HostEditorMachineApi } from './types';

type Policy = { mode: 'system' | 'direct' | 'proxy'; proxy: string; extraPorts: number[] };
type Snapshot = {
  revision: string;
  policy: Policy;
  clash: { available: boolean; groups: string[]; reason?: string; tun?: boolean; routed?: boolean; mode?: string; matches?: { chains: string[]; rule?: string; port?: string }[] };
  route?: { interface?: string } | null;
  endpoint: { host?: string; port: number };
};
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function NetworkSettings({ alias, api, saved }: { alias: string; api?: HostEditorMachineApi; saved: boolean }) {
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [policy, setPolicy] = useState<Policy>({ mode: 'system', proxy: '', extraPorts: [] });
  const [ports, setPorts] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let canceled = false;
    ++generation.current;
    setSnapshot(null); setNotice(''); setFailed(false);
    if (!saved || !api) return;
    setBusy(true);
    api('networkRead', { alias }).then((value) => {
      if (canceled) return;
      const next = value as Snapshot;
      setSnapshot(next); setPolicy(next.policy); setPorts(next.policy.extraPorts.join(', '));
    }).catch((error: unknown) => { if (!canceled) { setFailed(true); setNotice(message(error)); } })
      .finally(() => { if (!canceled) setBusy(false); });
    return () => { canceled = true; ++generation.current; };
  }, [alias, api, saved, reload]);

  async function save(): Promise<void> {
    if (!snapshot || !api || busy) return;
    const extraPorts = ports.trim() ? ports.split(/[,，\s]+/).filter(Boolean).map(Number) : [];
    if (extraPorts.length > 16 || extraPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
      setFailed(true); setNotice('附加端口应为 1–65535 的整数，最多 16 个。'); return;
    }
    const version = generation.current;
    setBusy(true); setFailed(false); setNotice('');
    try {
      const result = await api('networkSave', { alias, revision: snapshot.revision, policy: { ...policy, extraPorts } }) as { note?: string };
      if (version !== generation.current) return;
      const next = await api('networkRead', { alias }) as Snapshot;
      if (version !== generation.current) return;
      setSnapshot(next); setPolicy(next.policy); setPorts(next.policy.extraPorts.join(', '));
      setNotice(result.note ?? '网络策略已保存。');
    } catch (error) { if (version === generation.current) { setFailed(true); setNotice(message(error)); } }
    finally { if (version === generation.current) setBusy(false); }
  }

  return <section className="host-editor__section">
    <div className="host-editor__section-head"><h3>网络策略</h3></div>
    {!saved || !api ? <p className="host-editor__locked-note">保存机器后可设置网络策略。</p> : <>
      <p>策略使用已保存的主机地址；修改地址、端口或跳板机前先恢复跟随系统。Clash 策略匹配此目标地址的 SSH 和附加端口，影响访问这些端口的所有程序，并写入当前订阅。</p>
      {snapshot ? <>
        <p>目标：{snapshot.endpoint.host ?? '由堡垒机脚本管理'}:{snapshot.endpoint.port} · 系统接口：{snapshot.route?.interface ?? '未知'} · Clash：{snapshot.clash.available ? (snapshot.clash.tun ? 'TUN 已启用' : '已连接') : '未检测到'}</p>
        {snapshot.clash.matches?.length ? <p>当前 Clash 连接：{snapshot.clash.matches.map((match) => `${match.port} → ${match.chains.join(' → ')}（${match.rule ?? '未知规则'}）`).join('；')}</p> : null}
        <Field label="连接策略" htmlFor="host-editor-network-mode">
          <Select id="host-editor-network-mode" ariaLabel="连接策略" value={policy.mode} disabled={busy}
            options={[{ value: 'system', label: '跟随系统' }, { value: 'direct', label: 'Clash 直连', disabled: !snapshot.clash.available || snapshot.clash.routed === false || (snapshot.clash.mode !== undefined && snapshot.clash.mode !== 'rule') }, { value: 'proxy', label: 'Clash 指定代理组', disabled: !snapshot.clash.available || snapshot.clash.routed === false || (snapshot.clash.mode !== undefined && snapshot.clash.mode !== 'rule') }]}
            onChange={(mode) => { setNotice(''); setPolicy((current) => ({ ...current, mode: mode as Policy['mode'] })); }} />
        </Field>
        {policy.mode === 'proxy' ? <Field label="代理组" htmlFor="host-editor-network-proxy">
          <Select id="host-editor-network-proxy" ariaLabel="代理组" value={policy.proxy} disabled={busy}
            options={snapshot.clash.groups.map((group) => ({ value: group, label: group }))}
            onChange={(proxy) => { setNotice(''); setPolicy((current) => ({ ...current, proxy })); }} />
        </Field> : null}
        {policy.mode !== 'system' ? <Field label="附加端口" htmlFor="host-editor-network-ports" hint="例如 Netdata 的 19999。多个端口用逗号分隔，SSH 端口自动包含。">
          <Input id="host-editor-network-ports" value={ports} disabled={busy} onChange={(event) => { setNotice(''); setPorts(event.currentTarget.value); }} placeholder="19999" />
        </Field> : null}
        {snapshot.clash.mode && snapshot.clash.mode !== 'rule' ? <p>Clash 当前为 {snapshot.clash.mode} 模式。请先在 Clash 切换到规则模式，按目标设置才会生效。</p> : null}
        {snapshot.clash.routed === false ? <p>此目标未经过 Clash TUN，可能由 Tailscale 接管，应使用跟随系统。</p> : null}
        {!snapshot.clash.available ? <p>{snapshot.clash.reason}。跟随系统和普通 SSH 仍可使用。</p> : null}
        <p>更改前请暂停监控并断开此机器的共享会话。应用 Clash 规则时，已有连接可能需要重连；订阅切换后需重新检查。</p>
        <Button disabled={busy || (policy.mode === 'proxy' && !policy.proxy)} onClick={() => void save()}>保存网络策略</Button>
      </> : null}
      <Button variant="secondary" disabled={busy} onClick={() => setReload((value) => value + 1)}>{busy ? '正在读取…' : '重新检测'}</Button>
      {notice ? <p role={failed ? 'alert' : 'status'} aria-live="polite">{notice}</p> : null}
    </>}
  </section>;
}
