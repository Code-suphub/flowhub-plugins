(() => {
  if (window.FlowHubTheme) return;
  const key = 'flowhub.theme', hosted = window.parent !== window;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['light', 'dark', 'system'].includes(value);
  let preference = 'system', hostTheme;
  try {
    const saved = localStorage.getItem(key) || localStorage.getItem('flowhub.machines.theme');
    if (valid(saved)) preference = saved;
  } catch {}
  const resolved = () => hostTheme || (preference === 'system' ? (media.matches ? 'dark' : 'light') : preference);
  function apply() {
    document.documentElement.dataset.theme = resolved();
    document.documentElement.style.colorScheme = resolved();
    window.dispatchEvent(new Event('flowhub-theme-change'));
  }
  window.FlowHubTheme = {hosted, get: () => preference, set(value) {
    if (hosted || !valid(value)) return;
    preference = value;
    try { localStorage.setItem(key, value); } catch {}
    apply();
  }};
  window.addEventListener('message', event => {
    if (!hosted || event.source !== window.parent || event.data?.type !== 'flowhub:theme') return;
    if (!['light','dark'].includes(event.data.theme)) return;
    hostTheme = event.data.theme;
    preference = valid(event.data.preference) ? event.data.preference : hostTheme;
    apply();
  });
  window.addEventListener('storage', event => {
    if (hosted || (event.key !== key && event.key !== null)) return;
    preference = valid(event.newValue) ? event.newValue : 'system'; apply();
  });
  media.addEventListener('change', () => { if (!hostTheme && preference === 'system') apply(); });
  apply();
  if (hosted) window.parent.postMessage({type: 'flowhub:theme-ready'}, '*');
})();
