(() => {
  const api = window.FlowHubCommon || {};

  function bindHelp(root = document) {
    for (const help of root.querySelectorAll?.('.fh-help, .inline-help') || []) {
      if (help.dataset.fhHelpBound === 'true') continue;
      const button = help.querySelector('.fh-help__trigger, .help-trigger');
      const content = help.querySelector('.fh-help__content, .help-content');
      if (!button || !content) continue;
      const show = visible => {
        content.hidden = !visible;
        button.setAttribute('aria-expanded', String(visible));
      };
      help.dataset.fhHelpBound = 'true';
      help.onmouseenter = () => show(true);
      help.onmouseleave = () => { if (document.activeElement !== button) show(false); };
      button.onfocus = () => show(true);
      button.onblur = () => show(false);
      button.onclick = () => show(true);
      button.onkeydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); show(false); }
      };
    }
  }

  function mountNumberFields(root = document) {
    for (const input of root.querySelectorAll?.('input[type="number"]:not([data-number-control])') || []) {
      input.dataset.numberControl = 'true';
      const wrap = document.createElement('span');
      wrap.className = 'fh-number-control number-control';
      input.parentNode.insertBefore(wrap, input);
      wrap.append(input);
      const buttons = document.createElement('span');
      buttons.className = 'fh-number-control__buttons number-control-buttons';
      const makeButton = (label, delta) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'fh-number-step number-step';
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
  }

  function mountSelects(root = document, { searchIds = [] } = {}) {
    const controls = [];
    let opened;
    const close = () => { if (opened) { opened.menu.hidden = true; opened.button.setAttribute('aria-expanded', 'false'); opened = null; } };
    const register = select => {
      const shell = document.createElement('span'); shell.className = 'fh-select-shell select-shell';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'fh-select-trigger select-trigger';
      const label = select.labels?.[0]?.textContent.replace(select.textContent, '').trim() || '选择';
      button.setAttribute('aria-label', label); button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
      const menu = document.createElement('span'); menu.className = 'fh-select-menu select-menu'; menu.hidden = true;
      menu.id = `${select.id || 'select'}-options`; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', label); button.setAttribute('aria-controls', menu.id);
      select.after(shell); shell.append(button, menu); select.hidden = true;
      const search = searchIds.includes(select.id) ? document.createElement('input') : null;
      if (search) { search.type = 'search'; search.placeholder = '搜索名称或代码，如 中国 / China / CN'; search.setAttribute('aria-label', '搜索国家或地区'); search.className = 'select-search'; }
      const control = { select, button, menu, shell, search, signature: '' };
      const filter = () => { const query = search.value.trim().toLocaleLowerCase(); let found = false; for (const option of menu.querySelectorAll('[role="option"]')) { option.hidden = !option.dataset.search.includes(query); if (!option.hidden) found = true; } if (control.empty) control.empty.hidden = found; };
      if (search) search.oninput = filter;
      controls.push(control);
      const show = () => { close(); sync(); if (select.disabled) return; opened = control; menu.hidden = false; button.setAttribute('aria-expanded', 'true'); if (search) { search.value = ''; filter(); search.focus(); } else (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild)?.focus(); };
      button.onclick = event => { event.preventDefault(); opened === control ? close() : show(); };
      button.onkeydown = event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show(); } };
      menu.onkeydown = event => {
        const options = [...menu.querySelectorAll('[role="option"]')].filter(option => !option.hidden && !option.disabled);
        const index = options.indexOf(document.activeElement);
        if (event.key === 'Escape') { event.preventDefault(); close(); button.focus(); }
        if (event.key === 'Tab') close();
        if (event.target === search && event.key === 'Enter') { event.preventDefault(); options[0]?.click(); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !(event.target === search && ['Home', 'End'].includes(event.key))) {
          event.preventDefault(); options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
        }
      };
      new MutationObserver(() => sync()).observe(select, { childList: true, subtree: true, attributes: true });
      select.addEventListener('change', sync);
    };
    const sync = () => {
      for (const control of controls) {
        control.button.disabled = control.select.disabled;
        control.button.textContent = control.select.selectedOptions[0]?.textContent || '请选择';
        const signature = JSON.stringify([...control.select.options].map(option => [option.value, option.textContent, option.disabled])) + control.select.value;
        if (signature === control.signature) continue;
        control.signature = signature;
        control.menu.replaceChildren(...[...control.select.options].map(option => {
          const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'option'); item.tabIndex = -1;
          item.dataset.search = `${option.textContent} ${option.value} ${option.dataset.search || ''}`.toLocaleLowerCase(); item.textContent = option.textContent; item.disabled = option.disabled; item.setAttribute('aria-selected', String(option.value === control.select.value));
          item.onclick = event => { event.preventDefault(); control.select.value = option.value; control.select.dispatchEvent(new Event('change', { bubbles: true })); close(); control.button.focus(); };
          return item;
        }));
        if (control.search) { control.empty = document.createElement('span'); control.empty.textContent = '未找到匹配地区'; control.empty.hidden = true; control.empty.setAttribute('role', 'status'); control.menu.prepend(control.search); control.menu.append(control.empty); }
      }
    };
    for (const select of root.querySelectorAll?.('select') || []) register(select);
    root.addEventListener?.('pointerdown', event => { if (opened && !opened.shell.contains(event.target)) close(); });
    root.addEventListener?.('click', event => { if (event.target.closest('[role="tab"]')) close(); });
    sync();
    return { sync, register };
  }

  function field(label, control, { hint = '', className = '' } = {}) {
    const wrapper = document.createElement('label');
    wrapper.className = `fh-field ${className}`.trim();
    const title = document.createElement('span');
    title.className = 'fh-field__label';
    title.textContent = label;
    wrapper.append(title, control);
    if (hint) {
      const note = document.createElement('small');
      note.className = 'fh-field__hint';
      note.textContent = hint;
      wrapper.append(note);
    }
    return wrapper;
  }

  function checkbox(label, { checked = false, onChange } = {}) {
    const wrapper = document.createElement('label');
    wrapper.className = 'fh-checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = checked;
    const text = document.createElement('span'); text.textContent = label;
    wrapper.append(input, text);
    if (onChange) input.addEventListener('change', () => onChange(input.checked, input));
    return wrapper;
  }

  function table({ columns = [], rows = [], empty = '暂无数据' } = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'fh-table-wrap';
    const table = document.createElement('table'); table.className = 'fh-table';
    const head = table.createTHead().insertRow();
    for (const column of columns) { const cell = document.createElement('th'); cell.textContent = column.label || column; head.append(cell); }
    const body = table.createTBody();
    if (!rows.length) { const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = columns.length || 1; cell.className = 'fh-table__empty'; cell.textContent = empty; }
    else for (const values of rows) { const row = body.insertRow(); for (const value of values) { const cell = row.insertCell(); cell.textContent = value == null ? '' : String(value); } }
    wrapper.append(table); return wrapper;
  }

  function pagination(root, { page = 1, pages = 1, onChange } = {}) {
    const target = typeof root === 'string' ? document.querySelector(root) : root;
    if (!target) return;
    target.classList.add('fh-pagination');
    target.dataset.page = String(page); target.dataset.pages = String(pages);
    const previous = target.querySelector('[data-page="previous"]');
    const next = target.querySelector('[data-page="next"]');
    const info = target.querySelector('[data-page-info]');
    if (previous) previous.disabled = page <= 1;
    if (next) next.disabled = page >= pages;
    if (info) info.textContent = `${page} / ${pages} 页`;
    if (onChange && !target.dataset.fhPaginationBound) {
      target.dataset.fhPaginationBound = 'true';
      previous?.addEventListener('click', () => onChange(Math.max(1, Number(target.dataset.page) - 1)));
      next?.addEventListener('click', () => onChange(Math.min(Number(target.dataset.pages), Number(target.dataset.page) + 1)));
    }
  }

  api.bindHelp = bindHelp;
  api.mountNumberFields = mountNumberFields;
  api.selects = { mount: mountSelects };
  api.field = field;
  api.checkbox = checkbox;
  api.table = table;
  api.pagination = pagination;
  window.FlowHubCommon = api;
  bindHelp();
  mountNumberFields();
  new MutationObserver(() => { bindHelp(); mountNumberFields(); }).observe(document.body, { childList: true, subtree: true });
})();
