import { useSyncExternalStore } from 'react';
import { Button } from '@flowhub/plugin-common/react';

declare global { interface Window { FlowHubTheme?: { hosted: boolean; get(): string; set(value: string): void }; } }
function snapshot() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
function subscribe(notify: () => void) {
  window.addEventListener('flowhub-theme-change', notify);
  return () => window.removeEventListener('flowhub-theme-change', notify);
}
export function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribe, snapshot, () => 'dark');
  if (window.FlowHubTheme?.hosted) return null;
  const label = theme === 'dark' ? '切换浅色主题' : '切换深色主题';
  return <Button id="themeSwitch" size="sm" variant="ghost" aria-label={label} title={label} aria-pressed={theme === 'light'} onClick={() => window.FlowHubTheme?.set(theme === 'dark' ? 'light' : 'dark')}>
    {theme === 'dark' ? '☀ 浅色' : '☾ 深色'}
  </Button>;
}
