import { AppError, type SignalRecord } from '../domain.js';
import type { AssetInfo } from '../assets.js';

export type QueueDraftMessage = Pick<SignalRecord, 'id' | 'content' | 'attachments'>;

/** Rebuild one editable input without losing source order or duplicating an asset reference. */
export function queueDraft(messages: readonly QueueDraftMessage[], currentText: string, currentAttachments: readonly AssetInfo[], metadata: ReadonlyMap<string, AssetInfo>) {
  const text = [...messages.map(message => message.content), currentText].filter(part => part.trim()).join('\n\n');
  const assets = new Map<string, AssetInfo>();
  for (const message of messages) for (const id of message.attachments ?? []) {
    const item = metadata.get(id); if (!item || item.id !== id) throw new AppError('queue_attachment_unavailable', 409);
    assets.set(id, item);
  }
  for (const item of currentAttachments) assets.set(item.id, item);
  const attachments = [...assets.values()];
  if (text.length > 64_000 || attachments.length > 8 || attachments.reduce((total, item) => total + item.bytes, 0) > 32 * 1024 * 1024) throw new AppError('queue_draft_too_large', 409);
  return { text, attachments };
}
