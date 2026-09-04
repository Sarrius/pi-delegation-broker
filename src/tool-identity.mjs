/**
 * Canonical identities shared by child context capture, provider frames, and the child proxy.
 * Native OpenAI Responses joins call/item ids with `|`; Cursor Grok's OpenAI-compatible SSE
 * adapter uses one LF for the same two bounded components. No other control character is valid.
 */
export const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
export const TOOL_CALL_ID = /^(?=[\s\S]{1,128}$)[A-Za-z0-9][A-Za-z0-9._:-]*(?:(?:\||\n)[A-Za-z0-9][A-Za-z0-9._:-]*)?$/;
