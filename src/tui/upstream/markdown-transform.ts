// Pi coding-agent markdown-transform.ts, commit 9ee7586a95f5e653ae279c3b8f20938faf3639a1.
// Copyright (c) 2025 Mario Zechner; MIT license in LICENSE.
export interface MarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
	messageId?: string;
	timestamp?: string;
}
export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

/** Applies extension Markdown transformers. `isStreaming` is read per transform, so a reused component sees a stream end. */
export function createMarkdownTransform(
	messageType: MarkdownTransformContext["messageType"],
	isStreaming: () => boolean,
	transformers: readonly MarkdownTransformer[],
	messageId?: string,
	timestamp?: string,
): (markdown: string, availableWidth: number) => string {
	return (markdown, availableWidth) =>
		applyMarkdownTransformers(
			markdown,
			{ messageType, isStreaming: isStreaming(), availableWidth, messageId, timestamp },
			transformers,
		);
}

function applyMarkdownTransformers(
	markdown: string,
	context: MarkdownTransformContext,
	transformers: readonly MarkdownTransformer[],
): string {
	let transformedMarkdown = markdown;
	for (const transformer of transformers) {
		try {
			const transformed = transformer(transformedMarkdown, context);
			if (typeof transformed === "string") {
				transformedMarkdown = transformed;
			}
		} catch {
			// Keep the current Markdown and continue with the next transformer.
		}
	}
	return transformedMarkdown;
}
