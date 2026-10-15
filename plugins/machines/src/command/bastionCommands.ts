import type { ComboboxOption } from '@flowhub/plugin-common/react';
import type { CommandTemplate } from './types';

export const BUILTIN_QUERIES = ['uptime', 'hostname', 'uname -a', 'df -h /', 'free -m'];

export function bastionCommandOptions(templates: readonly CommandTemplate[], readOnly: boolean): ComboboxOption[] {
  const options = new Map<string, ComboboxOption>();
  for (const template of templates) {
    const command = template.command.trim();
    if (!command || (readOnly && !BUILTIN_QUERIES.includes(command))) continue;
    options.set(command, { value: template.command, label: template.name, search: template.command });
  }
  for (const command of BUILTIN_QUERIES) {
    if (!options.has(command)) options.set(command, { value: command, label: command });
  }
  return [...options.values()];
}
