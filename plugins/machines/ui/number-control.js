(() => {
  const sync = () => {
    for (const input of document.querySelectorAll('input[type="number"]:not([data-number-control])')) {
      input.dataset.numberControl = 'true';
      const wrap = document.createElement('span');
      wrap.className = 'number-control';
      input.parentNode.insertBefore(wrap, input);
      wrap.append(input);
      const buttons = document.createElement('span');
      buttons.className = 'number-control-buttons';
      const makeButton = (label, delta) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'number-step';
        button.tabIndex = -1;
        button.textContent = label;
        button.setAttribute('aria-label', `${input.labels?.[0]?.textContent?.trim() || '数值'}${delta > 0 ? '增加' : '减少'}`);
        button.onclick = () => {
          if (input.disabled) return;
          const step = input.step && input.step !== 'any' ? Number(input.step) : 1;
          const current = Number(input.value);
          const fallback = Number.isFinite(Number(input.min)) ? Number(input.min) : 0;
          const next = (Number.isFinite(current) ? current : fallback) + delta * (Number.isFinite(step) && step > 0 ? step : 1);
          const min = Number.isFinite(Number(input.min)) ? Number(input.min) : -Infinity;
          const max = Number.isFinite(Number(input.max)) ? Number(input.max) : Infinity;
          input.value = String(Math.min(max, Math.max(min, next)));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        return button;
      };
      buttons.append(makeButton('−', -1), makeButton('+', 1));
      wrap.append(buttons);
    }
  };
  window.FlowHubNumberFields = { sync };
  sync();
  new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
})();
