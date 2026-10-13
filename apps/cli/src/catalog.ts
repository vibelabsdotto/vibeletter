import type { Command } from 'commander';

export interface HttpOperation { method: string; path: string; action?: string; note?: string }
function httpFor(parts: string[]): HttpOperation | undefined {
  const [resource, operation] = parts;
  if (resource === 'health') return { method: 'GET', path: '/api/v1/health/details' };
  if (resource === 'readiness') return { method: 'GET', path: '/api/v1/health', note: 'public readiness, no Authorization header' };
  if (resource === 'overview') return { method: 'GET', path: '/api/v1/overview' };
  if (!resource || !operation || resource === 'context' || resource === 'catalog' || resource === 'help') return undefined;
  const route = resource === 'keys' ? 'api-keys' : resource;
  if (resource === 'newsletters' && operation === 'welcome-test') return { method: 'POST', path: '/api/v1/newsletters/[id]/actions', action: operation };
  if (resource === 'domains' && operation === 'account') return { method: 'GET', path: '/api/v1/domains/account' };
  if (resource === 'domains' && operation === 'dns') return { method: 'GET', path: '/api/v1/domains/[domain]/dns' };
  if (resource === 'contacts' && operation === 'import') return { method: 'POST', path: '/api/v1/contacts/import', note: 'JSON {newsletter,rows,source?}, sequential batches, no retry' };
  if (resource === 'contacts' && operation === 'export') return { method: 'GET', path: '/api/v1/contacts/export', note: 'format=json, all pages, CSV encoded locally, JSON preserves all record fields' };
  if (resource === 'contacts' && operation === 'status') return { method: 'POST', path: '/api/v1/contacts/[id]/status', note: 'JSON {status:active|unsubscribed}' };
  if (resource === 'campaigns' && ['preview', 'report'].includes(operation)) return { method: 'GET', path: `/api/v1/campaigns/[id]/${operation}` };
  if (resource === 'campaigns' && ['test', 'send', 'schedule', 'unschedule', 'pause', 'resume', 'send-more', 'duplicate', 'pin', 'archive-slug', 'discard', 'cleanup-preview'].includes(operation)) {
    return { method: 'POST', path: '/api/v1/campaigns/[id]/actions', action: operation, note: 'JSON {action,...options}' };
  }
  if (resource === 'domains' && operation === 'verify') return { method: 'POST', path: '/api/v1/domains/[domain]/verify' };
  if (resource === 'queue' && ['retry', 'cancel'].includes(operation)) return { method: 'POST', path: `/api/v1/queue/[id]/${operation}` };
  if (resource === 'uploads') return { method: 'POST', path: '/api/v1/uploads', note: 'raw image bytes, image Content-Type, X-File-Name, no multipart' };
  if (resource === 'campaigns' && operation === 'list') return { method: 'GET', path: '/api/v1/campaigns', note: '{items,total,limit,offset,issues,issuesTotal,issuesLimit,issuesOffset}; --all reads both collections independently' };
  if (operation === 'list') return { method: 'GET', path: `/api/v1/${route}`, note: '{items,total,limit,offset}' };
  if (operation === 'get') return { method: 'GET', path: `/api/v1/${route}/${resource === 'domains' ? '[domain]' : '[id]'}` };
  if (operation === 'create' || operation === 'add') return { method: 'POST', path: `/api/v1/${route}` };
  if (operation === 'update') return { method: 'PATCH', path: `/api/v1/${route}/[id]` };
  if (['delete', 'revoke', 'remove'].includes(operation)) return { method: 'DELETE', path: `/api/v1/${route}/[id]` };
  return undefined;
}

export function commandEntries(program: Command): { command: Command; parts: string[] }[] {
  const entries: { command: Command; parts: string[] }[] = [{ command: program, parts: [] }];
  const walk = (parent: Command, prefix: string[]): void => {
    for (const command of parent.commands) {
      const parts = [...prefix, command.name()];
      entries.push({ command, parts });
      walk(command, parts);
    }
  };
  walk(program, []);
  return entries;
}

export function buildCatalog(program: Command): unknown {
  return {
    name: program.name(), version: program.version(), apiVersion: 'v1',
    authentication: { bearer: true, tokenArgv: false, tokenSources: ['VIBELETTER_TOKEN', 'context set --token-stdin', 'context set --token-file', 'context set --token-env'], scopesGrantedByServer: true },
    commands: commandEntries(program).map(({ command, parts }) => ({
      command: [program.name(), ...parts].join(' '),
      description: command.description(),
      group: command.commands.length > 0,
      arguments: command.registeredArguments.map((arg) => ({ name: arg.name(), required: arg.required, variadic: arg.variadic })),
      options: command.options.map((option) => ({ flags: option.flags, description: option.description,
        requiredValue: option.required, mandatory: option.mandatory, ...(option.defaultValue !== undefined ? { default: option.defaultValue as unknown } : {}),
      })),
      ...(parts.length ? { globalOptions: program.options.map((option) => option.flags) } : {}),
      ...(httpFor(parts) ? { http: httpFor(parts) } : {}),
    })),
  };
}
