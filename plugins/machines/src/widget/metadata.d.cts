export interface ExpiryInfo { text: string; urgent: boolean; expired: boolean }
export interface TrafficInfo { kind: 'usage' | 'quota' | 'empty'; label: string; title?: string; hint?: string }
export function flag(code?: string): string;
export function expiry(at?: number | null, now?: number): ExpiryInfo | null;
export function traffic(value?: Record<string, unknown> | null, now?: number): TrafficInfo;
