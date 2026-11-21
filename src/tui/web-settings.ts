import type { AutomaticWebConfiguration, WebProviderName, WebProviderRuntime } from '../web/provider-config.js';

type Item = { value: string; label: string; description?: string };
interface Host { choose(title: string, items: Item[]): Promise<string | undefined>; prompt(title: string, initial?: string): Promise<string | undefined>; note(text: string): void }
type Catalog = WebProviderRuntime['catalog'];
export const automaticWebDefaults = (): AutomaticWebConfiguration => ({ type: 'auto', keylessFallback: true, keylessRescue: true, cacheEnabled: true, cacheTtlMinutes: 20, providerTiers: {}, providers: {} });

export function webRouteLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return '未提供';
  const route = value as { kind?: string; name?: string; mode?: string };
  return route.kind === 'disabled' ? '已停用' : route.kind === 'direct' ? '直接读取原网页' : route.kind === 'provider' && typeof route.name === 'string' ? `${route.name}（${route.mode === 'keyless' ? '免密钥' : '凭据模式'}）` : '未提供';
}

/** Edit a configuration draft; the caller saves it and reloads the Core's effective routes. */
export async function editAutomaticWeb(host: Host, initial: AutomaticWebConfiguration, catalog: Catalog): Promise<AutomaticWebConfiguration | undefined> {
  const draft = structuredClone(initial), enabled = (value: boolean) => value ? '开启' : '关闭';
  const names = catalog.map(row => row.id);
  const selectBackend = async (kind: 'search' | 'extract' | 'both') => {
    const field = kind === 'search' ? 'searchBackend' : kind === 'extract' ? 'extractBackend' : 'backend';
    const value = await host.choose('选择网页服务', [
      { value: '__unset__', label: kind === 'both' ? '不指定统一服务' : '沿用统一服务' },
      ...(kind === 'both' ? [] : [{ value: 'auto', label: '自动选择' }, { value: 'none', label: '停用' }]),
      ...(kind === 'extract' ? [{ value: 'direct', label: '直接读取原网页' }] : []),
      ...catalog.filter(row => kind === 'extract' ? row.extract : row.search).map(row => ({ value: row.id, label: row.id, description: row.credentialConfigured ? '已配置凭据或服务' : row.keyless ? '可免密钥使用' : '尚未配置凭据或服务' })),
    ]);
    if (value === undefined) return;
    if (value === '__unset__') { delete draft[field]; return; }
    if (field === 'backend') { if (names.includes(value as WebProviderName)) draft.backend = value as WebProviderName; }
    else if (field === 'searchBackend') draft.searchBackend = value as AutomaticWebConfiguration['searchBackend'];
    else draft.extractBackend = value as AutomaticWebConfiguration['extractBackend'];
  };
  for (;;) {
    const action = await host.choose('网页服务 · 尚未保存的设置', [
      { value: 'save', label: '完成并保存' }, { value: 'cancel', label: '放弃修改' },
      { value: 'search', label: '搜索服务', description: draft.searchBackend ?? '沿用统一服务' },
      { value: 'extract', label: '网页读取服务', description: draft.extractBackend ?? '沿用统一服务' },
      { value: 'both', label: '统一服务', description: draft.backend ?? '自动选择' },
      { value: 'providers', label: '服务地址、凭据名称与额度类型' },
      { value: 'fallback', label: '无凭据时使用免密钥服务', description: enabled(draft.keylessFallback) },
      { value: 'rescue', label: '服务故障时尝试免密钥服务', description: enabled(draft.keylessRescue) },
      { value: 'cache', label: '复用近期网页结果', description: enabled(draft.cacheEnabled) },
      { value: 'ttl', label: '缓存有效分钟数', description: String(draft.cacheTtlMinutes) },
    ]);
    if (!action || action === 'cancel') return;
    if (action === 'save') return draft;
    if (action === 'search' || action === 'extract' || action === 'both') { await selectBackend(action); continue; }
    if (action === 'fallback' || action === 'rescue' || action === 'cache') {
      const field = action === 'fallback' ? 'keylessFallback' : action === 'rescue' ? 'keylessRescue' : 'cacheEnabled';
      const value = await host.choose('选择开关', [{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }]); if (value) draft[field] = value === 'true'; continue;
    }
    if (action === 'ttl') {
      const value = await host.prompt('缓存有效分钟数（1–1440）', String(draft.cacheTtlMinutes)); if (value === undefined) continue;
      const minutes = value.trim() ? Number(value) : NaN; if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440) draft.cacheTtlMinutes = minutes; else host.note('请输入 1–1440 之间的分钟数。'); continue;
    }
    if (action !== 'providers') continue;
    const provider = await host.choose('选择网页服务供应商', catalog.map(row => ({ value: row.id, label: row.id, description: `${row.credentialConfigured ? '已配置凭据或服务' : row.keyless ? '可免密钥使用' : '未配置'} · ${draft.providerTiers[row.id] ?? 'auto'}` })));
    if (!provider || !names.includes(provider as WebProviderName)) continue;
    const id = provider as WebProviderName, current = draft.providers[id] ?? {}, field = await host.choose(`${provider} 设置`, [
      { value: 'key', label: '凭据名称（不输入密钥）', description: current.apiKeyEnv ?? '沿用默认名称' },
      { value: 'endpoint', label: '服务地址', description: current.baseURL ?? catalog.find(row => row.id === id)?.endpoint },
      { value: 'tier', label: '额度类型', description: draft.providerTiers[id] ?? 'auto' },
      { value: 'reset', label: '恢复该服务的默认设置' },
    ]);
    if (field === 'reset') { delete draft.providers[id]; delete draft.providerTiers[id]; }
    else if (field === 'tier') { const tier = await host.choose('额度类型', [{ value: 'auto', label: '自动' }, { value: 'free', label: '免费' }, { value: 'paid', label: '付费' }]); if (tier === 'auto' || tier === 'free' || tier === 'paid') draft.providerTiers[id] = tier; }
    else if (field === 'key' || field === 'endpoint') {
      const key = field === 'key' ? 'apiKeyEnv' : 'baseURL', value = await host.prompt(field === 'key' ? '凭据名称（留空恢复默认名称）' : '服务地址（留空恢复默认地址）', current[key] ?? '');
      if (value === undefined) continue;
      if (value.trim()) draft.providers[id] = { ...current, [key]: value.trim() }; else { const next = { ...current }; delete next[key]; if (Object.keys(next).length) draft.providers[id] = next; else delete draft.providers[id]; }
    }
  }
}
