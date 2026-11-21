export function selectRoleTools(input: Readonly<{
  role: 'main' | 'work';
  naturalReply: boolean;
  outputKind: 'message' | 'artifact' | 'both' | 'none';
  boundLegacyOccurrence: boolean;
}>): Readonly<{ emitMessage: boolean; saveArtifact: boolean; reportOccurrence: boolean }> {
  return {
    emitMessage: !input.naturalReply && (input.role === 'main' || input.outputKind === 'message' || input.outputKind === 'both'),
    saveArtifact: input.role === 'work' && (input.outputKind === 'artifact' || input.outputKind === 'both'),
    reportOccurrence: input.role === 'work' && input.boundLegacyOccurrence,
  };
}
