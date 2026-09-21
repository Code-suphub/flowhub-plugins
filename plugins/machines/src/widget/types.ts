export interface WidgetRow { id: string; name: string; status?: string; countryCode?: string; expiresAt?: number; traffic?: Record<string, unknown>; values?: Record<string, number | null>; at?: string }
export interface WidgetSnapshot { rows?: WidgetRow[]; error?: string }
export interface WidgetContext { config?: { view?: string; row?: string; title?: string; metrics?: string[]; showCountry?: boolean; showExpiry?: boolean }; title?: string; snapshot?: WidgetSnapshot; preview?: boolean }
export interface FlowHubWidgetApi { onInit(handler: (context: WidgetContext) => void): void; invoke(params: Record<string, unknown>): Promise<any> }
