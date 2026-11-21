import { Editor,Input, getKeybindings, isKeyRepeat, Key, matchesKey, type EditorOptions, type EditorTheme, type TUI } from '@earendil-works/pi-tui';
/** Visible single-code-unit stand-ins keep input indices and terminal layout aligned. */
export function editorDisplayText(text:string):string{
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,char=>{const code=char.charCodeAt(0);return code<0x20?String.fromCharCode(0x2400+code):code===0x7f?'␡':'�';});
}

/** Product input preferences over Pi's editor and its native history state. */
export class TerminalEditor extends Editor {
  constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
    super(tui, theme, { ...options, historyCursorPlacement: options.historyCursorPlacement ?? 'end',displayText:options.displayText??editorDisplayText });
  }
}
export class TerminalInput extends Input {
  constructor(options:NonNullable<ConstructorParameters<typeof Input>[0]>={}){super({...options,displayText:options.displayText??editorDisplayText});}
}

// Pi coding-agent 1.5.1, CustomEditor.handleInput; MIT in upstream/LICENSE.
/** Active completion navigation and explicit history bindings precede application shortcuts. */
export function editorTakesPriority(editor: Editor, data: string): boolean {
  const keys = getKeybindings();
  return (editor.isShowingAutocomplete() && (keys.matches(data, 'tui.select.pageUp') || keys.matches(data, 'tui.select.pageDown')))
    || keys.matches(data, 'tui.editor.historyPrevious') || keys.matches(data, 'tui.editor.historyNext');
}

export function isMacCopyShortcut(data: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && matchesKey(data, Key.super('c'));
}

/** A held copy/interrupt key is one action; repeated editing/navigation keys remain usable. */
export function isRepeatedCopyOrInterrupt(data: string, platform: NodeJS.Platform = process.platform): boolean {
  return isKeyRepeat(data) && (isMacCopyShortcut(data, platform) || matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrlShift('c')) || matchesKey(data, Key.ctrl('x')));
}
