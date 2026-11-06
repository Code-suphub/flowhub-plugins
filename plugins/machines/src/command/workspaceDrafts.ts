import type { CommandHost } from './types';
export interface CommandDraft { command: string; query: string }
export const EMPTY_COMMAND_DRAFT: CommandDraft = { command: '', query: 'uptime' };
/** Configuration changes must not silently retarget an old command draft. */
export function commandContext(hosts: readonly CommandHost[], revisions?: Record<string, string>): string {
  return JSON.stringify(hosts.map(host => [host.id, host.alias, revisions?.[host.id] ?? '']).sort((a, b) => a[0].localeCompare(b[0])));
}
export function updateCommandDraft(drafts: ReadonlyMap<string, CommandDraft>, key: string, patch: Partial<CommandDraft>): ReadonlyMap<string, CommandDraft> {
  const next = new Map(drafts);
  next.delete(key);
  next.set(key, { ...(drafts.get(key) ?? EMPTY_COMMAND_DRAFT), ...patch });
  while (next.size > 32) next.delete(next.keys().next().value!);
  return next;
}
