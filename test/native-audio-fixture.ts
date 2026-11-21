import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** A real Windows executable, so the process adapter is tested without a shell or script association. */
export function windowsAudioExecutable(directory: string, mode: 'success' | 'fail' | 'invalid' | 'sleep'): string {
  const executable = path.join(directory, 'fixture-engine.exe');
  const valid = JSON.stringify({ transcription: [{ text: ' Synthetic ' }, { text: ' result. ' }] });
  const source = `using System; using System.IO; using System.Threading;
public static class SyntheticAudioEngine {
  public static int Main(string[] args) {
    string input = args[Array.IndexOf(args, "-f") + 1];
    string model = args[Array.IndexOf(args, "-m") + 1];
    string output = args[Array.IndexOf(args, "-of") + 1] + ".json";
    if (!File.Exists(input) || !File.Exists(model) || File.ReadAllBytes(input).Length < 44) return 2;
    string mode = ${JSON.stringify(mode)};
    if (mode == "sleep") { Thread.Sleep(Timeout.Infinite); return 0; }
    if (mode == "fail") return 1;
    File.WriteAllText(output, mode == "invalid" ? "{" : ${JSON.stringify(valid)});
    return 0;
  }
}`;
  const sourceFile = path.join(directory, 'fixture-engine.cs'); fs.writeFileSync(sourceFile, source);
  const script = '$ErrorActionPreference="Stop"; Add-Type -Path $env:SHITTIM_TEST_AUDIO_SOURCE -OutputAssembly $env:SHITTIM_TEST_AUDIO_EXECUTABLE -OutputType ConsoleApplication';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, SHITTIM_TEST_AUDIO_SOURCE: sourceFile, SHITTIM_TEST_AUDIO_EXECUTABLE: executable }, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native audio fixture compilation failed: ${result.stderr}`);
  return executable;
}
