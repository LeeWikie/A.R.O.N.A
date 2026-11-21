/*
 * Adapted from Pi 1.5.1 packages/mcp/src/naming.ts:
 * https://github.com/earendil-works/pi/blob/dd30101cfc5b0609411dd80b6f93adbc14db14cf/packages/mcp/src/naming.ts
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
/**
 * Names of MCP tools and of their servers' namespaces as models and code mode scripts see them.
 * Applications that name tools the same way rank and group them the same way in tool search and
 * code mode.
 */

import { createHash } from "node:crypto";

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long. Like Codex,
 * everything but `[A-Za-z0-9_]` becomes `_`, so the name is also the identifier code mode scripts
 * call it by. `isTaken` reports names used by a different MCP tool: sanitizing can map two tools to
 * one name (`a-b` and `a_b`), which then get the hash suffix.
 */
export function createMcpToolName(
	server: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * Namespace of a server's tools: `mcp__<server>` with `-` replaced by `_`, like the tool names. Server
 * names that differ only in `-` and `_` share a namespace, so a configuration must not have both.
 */
export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}

/** Preserve valid existing names while applying the native MCP collision and length rules. */
export function mcpModelToolName(server:string,raw:string,isTaken:(name:string)=>boolean){
 const legacy=`ext_${server}_${raw}`;if(/^[A-Za-z0-9_-]{1,64}$/.test(legacy)&&!isTaken(legacy))return legacy;
 const name=createMcpToolName(server,raw,name=>isTaken('ext_'+name.slice('mcp__'.length)));return 'ext_'+name.slice('mcp__'.length);
}
