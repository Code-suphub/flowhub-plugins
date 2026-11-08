import type { Artwork, Device, DeviceCatalog } from './model';

declare global {
  var FlowHubDeviceArt: {
    family(device: Device): string | undefined;
    resolve(device: Device, artwork?: Artwork, catalog?: DeviceCatalog): { src: string; fallback: string; label: string };
  };
}

export {};
