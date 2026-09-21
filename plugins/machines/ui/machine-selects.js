(() => {
  const controls = window.FlowHubCommon?.selects.mount(document);
  window.FlowHubSelects = controls || { sync() {} };
})();
