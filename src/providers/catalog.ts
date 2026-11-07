import type { AuthContext, CredentialStore, MutableModels } from '@earendil-works/pi-ai';
import { builtinModels, getBuiltinModelDataGeneratedAt } from '@earendil-works/pi-ai/providers/all';

/** Create a provider registry with explicitly supplied authentication sources. */
export function createProviderCatalog(options: { credentials: CredentialStore; authContext: AuthContext }): MutableModels {
  return builtinModels(options);
}

/** Generation time of the bundled catalog, not a guarantee that its entries are current. */
export function providerCatalogGeneratedAt(): number | undefined {
  return getBuiltinModelDataGeneratedAt();
}
