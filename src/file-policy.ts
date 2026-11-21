export function sensitiveFile(value: unknown): boolean {
  return typeof value === 'string' && /(^|[\\/])(?:\.env(?:\..*)?|\.ssh|\.private|\.codex|\.claude|\.arona|\.pi|\.aws|\.kube|credentials[^\\/]*|auth\.json|control-token|records\.sqlite(?:-wal|-shm)?|history\.sqlite(?:-wal|-shm)?|.*\.pem|.*\.key|id_rsa|id_ed25519)(?:$|[\\/])/i.test(value);
}
