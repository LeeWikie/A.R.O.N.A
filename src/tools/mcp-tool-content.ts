/*
 * Adapted from Pi 1.5.1 packages/coding-agent/src/extensions/mcp/tools.ts:
 * https://github.com/earendil-works/pi/blob/dd30101cfc5b0609411dd80b6f93adbc14db14cf/packages/coding-agent/src/extensions/mcp/tools.ts
 *
 * MIT License
 * 
 * Copyright (c) 2025 Mario Zechner
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {formatSize} from '@earendil-works/pi-coding-agent';
import {toLlmContent,type ContentBlock,type LlmContent} from './mcp-content.js';
import type {McpOutputSaver} from './mcp-output-limit.js';
const READ_MCP_RESOURCE_TOOL='read_mcp_resource';
export interface ConvertMcpResultOptions{saveOutput:McpOutputSaver;readableResources?:boolean}
/** File extension for a saved binary resource: the one its URI ends in, else `.bin`. */
function extensionOf(uri: string): string {
	const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
	return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

/** Blobs of these types are shown as text. */
export function isTextMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const type = mimeType.split(";", 1)[0]!.trim().toLowerCase();
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
}

/** Model-facing content of one block of `server`'s result. */
export async function blockToContent(
	server: string,
	block: ContentBlock,
	options: ConvertMcpResultOptions,
): Promise<(LlmContent)[]> {
	if (block.type === "resource_link") {
		const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
		const read = options.readableResources ? `. Read it with ${READ_MCP_RESOURCE_TOOL} (server "${server}")` : "";
		const description = block.description ? `: ${block.description}` : "";
		return [
			{
				type: "text",
				text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}${read}]`,
			},
		];
	}
	if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
		const { uri, mimeType, blob } = block.resource;
		const data = Buffer.from(blob, "base64");
		if (isTextMimeType(mimeType)) return [{ type: "text", text: data.toString("utf8") }];
		const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;
		try {
			const path = await options.saveOutput(data, extensionOf(uri));
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }];
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` }];
		}
	}
	return toLlmContent({ content: [block] });
}

/** Model-facing content of `server`'s content blocks, before the output limit. */
export async function toModelContent(
	server: string,
	blocks: readonly ContentBlock[],
	options: ConvertMcpResultOptions,
): Promise<(LlmContent)[]> {
	return (await Promise.all(blocks.map((block) => blockToContent(server, block, options)))).flat();
}

