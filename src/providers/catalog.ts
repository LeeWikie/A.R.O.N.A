import type { AuthContext, CredentialStore, MutableModels } from '@earendil-works/pi-ai';
import { builtinModels, getBuiltinModelDataGeneratedAt } from '@earendil-works/pi-ai/providers/all';
import type { ProviderCredentialStore } from './credential-store.js';

/** Create a provider registry with explicitly supplied authentication sources. */
export function createProviderCatalog(options: { credentials: CredentialStore; authContext: AuthContext }): MutableModels {
  const models = builtinModels(options);
  const credentials = options.credentials as CredentialStore & Partial<Pick<ProviderCredentialStore, 'confirmOAuthRefresh'>>;
  if (credentials.confirmOAuthRefresh) {
    for (const provider of models.getProviders()) {
      const oauth = provider.auth.oauth;
      if (!oauth) continue;
      models.setProvider({ ...provider, auth: { ...provider.auth, oauth: { ...oauth, refresh: (current, signal) => credentials.confirmOAuthRefresh!(provider.id, current, () => oauth.refresh(current, signal)) } } });
    }
  }
  return models;
}

/** Generation time of the bundled catalog, not a guarantee that its entries are current. */
export function providerCatalogGeneratedAt(): number | undefined {
  return getBuiltinModelDataGeneratedAt();
}
