(() => {
  const controls = window.FlowHubCommon?.selects.mount(document, { searchIds: ['hostCountry'] });
  window.FlowHubSelects = controls || { sync() {} };
})();
