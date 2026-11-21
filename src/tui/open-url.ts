import { spawn } from 'node:child_process';
import { AppError } from '../domain.js';

/** Ask the desktop to open an explicit HTTP(S) link without a shell command. */
export function webUrlCommand(value: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AppError('invalid_auth_url');
  if (platform === 'darwin') return { command: 'open', args: [url.href] };
  if (platform === 'win32') {
    const literal = url.href.replace(/'/g, "''");
    const code = `$target=[Diagnostics.ProcessStartInfo]::new('${literal}');$target.UseShellExecute=$true;[Diagnostics.Process]::Start($target)|Out-Null`;
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')] };
  }
  return { command: 'xdg-open', args: [url.href] };
}

export async function openWebUrl(value: string): Promise<void> {
  const { command, args } = webUrlCommand(value);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.unref(); resolve(); }, 5000);
    child.once('error', () => { clearTimeout(timer); reject(new AppError('browser_unavailable')); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new AppError('browser_unavailable')); });
  });
}
