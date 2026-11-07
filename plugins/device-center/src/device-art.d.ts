import type { Artwork, Device } from './model';

declare global {
  var FlowHubDeviceArt: {
    family(device: Device): string | undefined;
    resolve(device: Device, artwork?: Artwork): { src: string; fallback: string; system: boolean };
  };
}

export {};
