(() => {
  const tabs = [...document.querySelectorAll('[data-machine-tab]')];
  function show(name, focus = false) {
    const target = tabs.find(tab => tab.dataset.machineTab === name);
    if (!target) return;
    for (const tab of tabs) {
      const selected = tab === target;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) target.focus();
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => show(tab.dataset.machineTab);
    tab.onkeydown = event => {
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
      if (next === null) return;
      event.preventDefault(); show(tabs[next].dataset.machineTab, true);
    };
  });
  document.querySelectorAll('[data-machine-goto]').forEach(button => { button.onclick = () => show(button.dataset.machineGoto, true); });
  window.FlowHubMachineTabs = { show };
})();
