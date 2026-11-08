// Both desktop and React surfaces resolve the same bundled and macOS artwork.
(() => {
  const categories = new Set(['headphones','mouse','keyboard','phone','drive','hub','device','laptop','monitor','speaker','earbuds']);

  function family(device) {
    if (device.category === 'adb') return;
    const name = device.name.toLowerCase();
    if (device.kind === 'phone' && /^iphone(?:\b|\d)/.test(name)) return 'iphone';
    if (device.kind === 'headphones' && /^airpods\b/.test(name)) return /\bpro\b/.test(name) ? 'airpods-pro' : 'airpods';
    if (device.kind === 'mouse' && /\bmagic\s*mouse\b/.test(name)) return 'apple-mouse';
    if (device.kind === 'keyboard' && /^(?:magic|apple)\s+keyboard\b/.test(name)) return 'apple-keyboard';
    if (/^macbook\b/.test(name)) return 'macbook';
  }

  function resolve(device, artwork, catalog) {
    const kind = device.category === 'display' ? 'monitor'
      : categories.has(device.kind) ? device.kind : 'device';
    const fallback = 'assets/' + kind + '.svg';
    const photo = device.catalogKey && catalog?.[device.catalogKey]?.image?.dataUrl;
    if (typeof photo === 'string' && photo.length < 90_030
        && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/=]+$/.test(photo)) {
      return { src: photo, fallback, label: '设备型号参考图片' };
    }
    const key = family(device);
    const url = key && artwork?.icons?.[key]?.dataUrl;
    const system = typeof url === 'string' && url.length < 90_030
      && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]*$/.test(url);
    return { src: system ? url : fallback, fallback, label: system ? 'macOS 设备家族示意图' : '设备类别示意图' };
  }

  globalThis.FlowHubDeviceArt = { family, resolve };
})();
