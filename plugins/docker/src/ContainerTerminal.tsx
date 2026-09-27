import {useEffect, useRef, useState} from 'react';
import {FitAddon} from '@xterm/addon-fit';
import {Terminal} from '@xterm/xterm';
import {Button} from '@flowhub/plugin-common/react';
import type {ManagementApi} from './api';
import '@xterm/xterm/css/xterm.css';

interface TerminalRead {bytes: number[]; closed: boolean; dropped: boolean}
type Status = 'disconnected' | 'connecting' | 'connected' | 'ended';

export function ContainerTerminal({api, context, containerId, containerState, readOnly}: {
  api: ManagementApi; context: string; containerId: string; containerState: string; readOnly: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  const resizeTimer = useRef<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const themeObserverRef = useRef<MutationObserver | null>(null);
  const mounted = useRef(true);
  const [shell, setShell] = useState('/bin/sh');
  const [status, setStatus] = useState<Status>('disconnected');
  const [error, setError] = useState('');
  const [everConnected, setEverConnected] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
      observerRef.current?.disconnect();
      observerRef.current = null;
      themeObserverRef.current?.disconnect();
      themeObserverRef.current = null;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) void api.invoke('terminal_close', {session, context}).catch(() => {});
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [api, context, containerId]);

  function disconnect(nextStatus: Status = 'disconnected') {
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) void api.invoke('terminal_close', {session, context}).catch(() => {});
    if (mounted.current) setStatus(nextStatus);
  }

  function ensureTerminal() {
    if (terminalRef.current) return terminalRef.current;
    const host = hostRef.current!;
    const style = getComputedStyle(host);
    const accent = getComputedStyle(host.closest('.docker-page')!).getPropertyValue('--docker-accent').trim() || style.color;
    const terminal = new Terminal({
      cursorBlink: true, scrollback: 2000, convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12,
      theme: {background: style.backgroundColor, foreground: style.color, cursor: accent},
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current!);
    terminalRef.current = terminal;
    fitRef.current = fit;
    fit.fit();

    let queued = 0;
    const inputQueue: Array<{session: string; bytes: Uint8Array}> = [];
    let sending = false;
    async function drain() {
      if (sending) return;
      sending = true;
      try {
        while (inputQueue.length) {
          const item = inputQueue.shift()!;
          queued -= item.bytes.length;
          if (sessionRef.current !== item.session) continue;
          try {
            await api.invoke('terminal_write', {session: item.session, context, bytes: Array.from(item.bytes)});
          } catch (reason) {
            if (sessionRef.current === item.session) {
              if (mounted.current) setError(reason instanceof Error ? reason.message : '终端输入失败');
              disconnect('ended');
            }
          }
        }
      } finally { sending = false; }
    }
    terminal.onData((data) => {
      const session = sessionRef.current;
      if (!session) return;
      const bytes = new TextEncoder().encode(data);
      if (queued + bytes.length > 128 * 1024) {
        setError('输入过快，请等待终端处理后重试。');
        return;
      }
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        const part = bytes.slice(offset, offset + 8192);
        queued += part.length;
        inputQueue.push({session, bytes: part});
      }
      void drain();
    });

    const observer = new ResizeObserver(() => {
      if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
      resizeTimer.current = window.setTimeout(() => {
        if (!mounted.current) return;
        fit.fit();
        const session = sessionRef.current;
        if (session) void api.invoke('terminal_resize', {session, context, rows: terminal.rows, cols: terminal.cols}).catch(() => {});
      }, 80);
    });
    observer.observe(hostRef.current!);
    observerRef.current = observer;
    const themeObserver = new MutationObserver(() => {
      const next = getComputedStyle(host);
      terminal.options.theme = {
        background: next.backgroundColor,
        foreground: next.color,
        cursor: getComputedStyle(host.closest('.docker-page')!).getPropertyValue('--docker-accent').trim() || next.color,
      };
    });
    themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
    themeObserverRef.current = themeObserver;
    return terminal;
  }

  async function poll(session: string) {
    if (sessionRef.current !== session || !mounted.current) return;
    try {
      const result = await api.invoke<TerminalRead>('terminal_read', {session, context});
      if (sessionRef.current !== session || !mounted.current) return;
      if (result.dropped) terminalRef.current?.writeln('\r\n[输出过快，部分内容已跳过]');
      if (result.bytes.length) terminalRef.current?.write(Uint8Array.from(result.bytes));
      if (result.closed) {
        disconnect('ended');
        return;
      }
      pollTimer.current = window.setTimeout(() => {void poll(session);}, result.bytes.length ? 40 : 150);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '终端连接中断');
      disconnect('ended');
    }
  }

  async function connect() {
    if (readOnly || containerState !== 'running' || status === 'connecting' || sessionRef.current) return;
    const terminal = ensureTerminal();
    terminal.reset();
    fitRef.current?.fit();
    setError('');
    setStatus('connecting');
    setEverConnected(true);
    try {
      const result = await api.invoke<{session: string}>('terminal_open', {
        id: containerId, context, shell, rows: terminal.rows, cols: terminal.cols, confirmed: true,
      });
      if (!mounted.current) {
        void api.invoke('terminal_close', {session: result.session, context}).catch(() => {});
        return;
      }
      sessionRef.current = result.session;
      setStatus('connected');
      terminal.focus();
      void poll(result.session);
    } catch (reason) {
      if (mounted.current) {
        setStatus('ended');
        setError(reason instanceof Error ? reason.message : '无法连接终端');
      }
    }
  }

  const canConnect = !readOnly && containerState === 'running' && status !== 'connecting' && status !== 'connected';
  return <section className="docker-terminal" aria-label="容器交互终端">
    <div className="docker-terminal-toolbar">
      <label htmlFor="docker-terminal-shell">Shell</label>
      <select id="docker-terminal-shell" value={shell} disabled={status === 'connected' || status === 'connecting'} onChange={(event) => setShell(event.target.value)}>
        <option value="/bin/sh">/bin/sh</option><option value="/bin/bash">/bin/bash</option>
      </select>
      {status === 'connected' ? <Button size="sm" onClick={() => disconnect()}>断开终端</Button> : <Button size="sm" disabled={!canConnect} onClick={() => void connect()}>{status === 'connecting' ? '连接中…' : '连接终端'}</Button>}
      <span className="docker-terminal-status" role="status">{status === 'connected' ? '已连接' : status === 'connecting' ? '正在连接' : status === 'ended' ? '会话已结束' : '未连接'}</span>
    </div>
    <p className="docker-terminal-hint">命令在所选容器内执行，也可能影响其挂载的宿主资源；切换资源或离开此标签会断开会话。</p>
    {readOnly ? <p className="docker-terminal-hint">只读模拟预览不连接终端。</p> : containerState !== 'running' ? <p className="docker-terminal-hint">请先启动容器，再连接终端。</p> : null}
    {error ? <p className="docker-error" role="alert">{error}</p> : null}
    <div className="docker-terminal-screen">
      <div ref={hostRef} className="docker-terminal-host"/>
      {!everConnected ? <span className="docker-terminal-placeholder">连接后可直接键入命令。支持持续会话、交互输入及窗口缩放。</span> : null}
    </div>
  </section>;
}
