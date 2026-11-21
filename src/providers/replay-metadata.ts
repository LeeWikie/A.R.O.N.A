type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value); }

export function isResponsesApi(api: unknown): api is 'openai-responses' | 'azure-openai-responses' | 'openai-codex-responses' {
  return api === 'openai-responses' || api === 'azure-openai-responses' || api === 'openai-codex-responses';
}

function responsesItem(signature: unknown) {
  if (typeof signature !== 'string') return undefined;
  let item: unknown;
  try { item = JSON.parse(signature); } catch { return undefined; }
  if (!record(item) || item.type !== 'reasoning' || typeof item.id !== 'string' || !item.id) return undefined;
  return item as RecordValue & { id: string };
}

/** Mirror actual terminal identity without treating signature JSON as ciphertext. */
export function responsesReplayMetadata(api: string, signature: unknown) {
  const namespace = api === 'azure-openai-responses' ? 'azure' : isResponsesApi(api) ? 'openai' : undefined;
  const item = namespace && responsesItem(signature);
  if (!item) return undefined;
  return { namespace, value: { itemId: item.id,
    ...(typeof item.encrypted_content === 'string' || item.encrypted_content === null ? { reasoningEncryptedContent: item.encrypted_content } : {}) } };
}

function validLegacySignature(signature: unknown) {
  const item = responsesItem(signature);
  if (!item || item.id.length > 64
    || !Array.isArray(item.summary) || item.summary.some(part => !record(part) || part.type !== 'summary_text' || typeof part.text !== 'string'
      || Object.keys(part).some(key => key !== 'type' && key !== 'text'))
    || (item.encrypted_content !== undefined && item.encrypted_content !== null && typeof item.encrypted_content !== 'string')
    || (item.status !== undefined && (typeof item.status !== 'string' || !['in_progress', 'completed', 'incomplete'].includes(item.status)))
    || (item.content !== undefined && (!Array.isArray(item.content) || item.content.some(part => !record(part) || part.type !== 'reasoning_text' || typeof part.text !== 'string'
      || Object.keys(part).some(key => key !== 'type' && key !== 'text'))))
    || Object.keys(item).some(key => !['type', 'id', 'summary', 'encrypted_content', 'status', 'content'].includes(key))) return false;
  return true;
}

/** Repair a request-only view; never infer the producing model from the target model. */
export function legacyResponsesMetadata<T extends RecordValue>(metadata: T | undefined): T | undefined {
  if (!record(metadata) || !record(metadata.pi)) return undefined;
  const pi = metadata.pi;
  const origin = pi.provenance;
  if (!record(origin)) {
    if ('thinkingSignature' in pi) throw new Error('Untrusted legacy reasoning provenance');
    return undefined;
  }
  if (Object.keys(origin).some(key => !['api', 'provider', 'model'].includes(key))
    || ['api', 'provider', 'model'].some(key => typeof origin[key] !== 'string' || !origin[key])) throw new Error('Untrusted legacy reasoning provenance');
  if (!isResponsesApi(origin.api)) return undefined;
  if (Object.keys(pi).some(key => !['provenance', 'thinkingSignature', 'redacted'].includes(key))
    || (pi.redacted !== undefined && pi.redacted !== false)) throw new Error('Untrusted legacy Responses provenance');
  const native = responsesReplayMetadata(origin.api, pi.thinkingSignature);
  if (!native || !validLegacySignature(pi.thinkingSignature)) throw new Error('Invalid legacy Responses reasoning signature');
  // Native identity must agree with the Pi item, including the absence of ciphertext.
  // A second provider namespace is ambiguous, even if its item happens to match.
  const other = native.namespace === 'openai' ? 'azure' : 'openai';
  if (metadata[other] !== undefined) throw new Error('Conflicting legacy Responses metadata');
  const existing = metadata[native.namespace];
  if (existing !== undefined) {
    if (!record(existing) || existing.itemId !== native.value.itemId
      || existing.reasoningEncryptedContent !== native.value.reasoningEncryptedContent
      || (existing.encryptedContent !== undefined && existing.encryptedContent !== native.value.reasoningEncryptedContent)) throw new Error('Conflicting legacy Responses metadata');
    return undefined;
  }
  return { ...metadata, [native.namespace]: native.value };
}
