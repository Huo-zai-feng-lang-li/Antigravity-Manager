/**
 * logPayloadParser.ts
 * 负责将原始代理请求/响应报文解析为人类易读的对话结构（用户提问、深度思考、模型回答、工具调用、错误原因）
 * 严格遵循架构防腐与防御性编程原则：纯函数、零状态、多层容错、异常安全降级。
 */

export interface MessageItem {
    role: 'user' | 'assistant' | 'system' | 'tool' | string;
    content: string;
}

export interface ToolCallItem {
    name: string;
    args?: string;
}

export interface ParsedConversation {
    /** 是否成功提取到对话内容 */
    isChat: boolean;
    /** 用户提问（最后一条用户发言） */
    userPrompt: string | null;
    /** 系统提示词设定（如有） */
    systemPrompt: string | null;
    /** 历史所有对话轮次（用于展开查看上下文） */
    allMessages: MessageItem[];
    /** 深度思考过程（如 DeepSeek R1 / Claude Thinking） */
    thinking: string | null;
    /** 模型的最终回复正文 */
    modelAnswer: string | null;
    /** 工具/函数调用信息（如有） */
    toolCalls: ToolCallItem[];
    /** 错误信息（4xx/5xx 或 error 响应） */
    errorMessage: string | null;
    /** 原始报文是否为合法 JSON */
    isRawJson: boolean;
}

/**
 * 尝试安全解析 JSON，兼容后端截断标记 `...[truncated XXX chars]`
 */
export function tryParseJson(text?: string | null): any {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    try {
        return JSON.parse(trimmed);
    } catch {
        // 如果末尾带有 ...[truncated 
        const truncatedIdx = trimmed.indexOf('...[truncated ');
        if (truncatedIdx > 0) {
            const cut = trimmed.substring(0, truncatedIdx).trim();
            // 尝试通过闭合常见引号与括号进行抢救
            const suffixes = ['', '"', '"}', '"]}', '"}]}', '}]}', '}'];
            for (const suffix of suffixes) {
                try {
                    return JSON.parse(cut + suffix);
                } catch {
                    // 继续尝试下一个后缀
                }
            }
        }
    }
    return null;
}

/**
 * 解析单条消息的 content 字段（支持 string、数组、多模态 block）
 */
function extractContentText(content: any): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const item of content) {
            if (typeof item === 'string') {
                parts.push(item);
            } else if (item && typeof item === 'object') {
                if (item.type === 'text' && typeof item.text === 'string') {
                    parts.push(item.text);
                } else if (item.type === 'image_url' || item.type === 'image') {
                    parts.push('[图片]');
                } else if (item.type === 'input_audio') {
                    parts.push('[音频]');
                } else if (item.text && typeof item.text === 'string') {
                    parts.push(item.text);
                }
            }
        }
        return parts.join('\n');
    }
    if (content && typeof content === 'object') {
        if (typeof content.text === 'string') return content.text;
    }
    return '';
}

/**
 * 从 JSON 对象中提取请求信息（用户提问、系统设定、完整消息流）
 */
function extractRequestInfo(json: any): {
    userPrompt: string | null;
    systemPrompt: string | null;
    allMessages: MessageItem[];
    isChat: boolean;
} {
    const allMessages: MessageItem[] = [];
    let systemPrompt: string | null = null;
    let userPrompt: string | null = null;

    if (!json || typeof json !== 'object') {
        return { userPrompt: null, systemPrompt: null, allMessages: [], isChat: false };
    }

    // 1. 标准 messages 数组（OpenAI / Claude / Responses 格式）
    if (Array.isArray(json.messages)) {
        for (const msg of json.messages) {
            if (!msg || typeof msg !== 'object') continue;
            const role = String(msg.role || '').toLowerCase();
            const text = extractContentText(msg.content);

            allMessages.push({ role, content: text });

            if (role === 'system' || role === 'developer') {
                if (!systemPrompt) {
                    systemPrompt = text;
                } else {
                    systemPrompt += '\n\n' + text;
                }
            } else if (role === 'user') {
                userPrompt = text; // 循环结束保留最后一条用户提问
            }
        }
    }

    // 2. Claude system 顶层字段（Claude 常见规范）
    if (json.system) {
        const claudeSystem = extractContentText(json.system);
        if (claudeSystem) {
            systemPrompt = systemPrompt ? `${systemPrompt}\n\n${claudeSystem}` : claudeSystem;
        }
    }

    // 3. Responses API instructions 字段
    if (json.instructions && typeof json.instructions === 'string') {
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${json.instructions}` : json.instructions;
    }

    // 4. Gemini 原生 contents 数组格式
    if (!userPrompt && Array.isArray(json.contents)) {
        for (const item of json.contents) {
            if (!item || typeof item !== 'object') continue;
            const role = String(item.role || 'user').toLowerCase();
            const parts: string[] = [];
            if (Array.isArray(item.parts)) {
                for (const part of item.parts) {
                    if (part && typeof part.text === 'string') {
                        parts.push(part.text);
                    }
                }
            }
            const text = parts.join('\n');
            allMessages.push({ role, content: text });
            if (role === 'user') {
                userPrompt = text;
            }
        }
    }

    // 5. 顶层 prompt 字段（Completions / 图像生成接口）
    if (!userPrompt && json.prompt) {
        userPrompt = extractContentText(json.prompt);
        if (userPrompt) {
            allMessages.push({ role: 'user', content: userPrompt });
        }
    }

    // 6. Responses API input 字段
    if (!userPrompt && json.input) {
        userPrompt = extractContentText(json.input);
        if (userPrompt) {
            allMessages.push({ role: 'user', content: userPrompt });
        }
    }

    const isChat = Boolean(userPrompt || allMessages.length > 0);
    return { userPrompt, systemPrompt, allMessages, isChat };
}

/**
 * 正则回退扫描：当请求报文被截断导致非合法 JSON 时的抢救机制
 */
function fallbackExtractRequestFromTruncated(text: string): string | null {
    if (!text.includes('"role"') && !text.includes('"messages"')) return null;

    // 尝试寻找最后一个 "role": "user"
    const userRoleIdx = text.lastIndexOf('"role": "user"');
    const altUserRoleIdx = text.lastIndexOf('"role":"user"');
    const targetIdx = Math.max(userRoleIdx, altUserRoleIdx);

    if (targetIdx !== -1) {
        const afterUser = text.substring(targetIdx);
        // 1. 如果有完整的闭合引号
        const contentMatch = afterUser.match(/"content":\s*"((?:[^"\\]|\\.)*)"/);
        if (contentMatch && contentMatch[1]) {
            try {
                return JSON.parse(`"${contentMatch[1]}"`);
            } catch {
                return contentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
            }
        }
        // 2. 如果截断发生在字符串内部（未闭合双引号，直接被截断）
        const unclosedMatch = afterUser.match(/"content":\s*"([^"\\]*?)(?:\.\.\.\[truncated|$)/);
        if (unclosedMatch && unclosedMatch[1]) {
            return unclosedMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        }
    }
    return null;
}

/**
 * 解析响应报文（回答文本、思考链、工具调用、错误信息）
 */
function extractResponseInfo(
    json: any,
    status: number,
    rawResponseBody?: string,
    logError?: string
): {
    modelAnswer: string | null;
    thinking: string | null;
    toolCalls: ToolCallItem[];
    errorMessage: string | null;
} {
    let modelAnswer: string | null = null;
    let thinking: string | null = null;
    const toolCalls: ToolCallItem[] = [];
    let errorMessage: string | null = null;

    // 1. 错误优先判定（状态码 >= 400 或存在显式 error 字段）
    if (status >= 400 || logError) {
        if (logError) {
            errorMessage = logError;
        } else if (json && typeof json === 'object') {
            if (json.error) {
                if (typeof json.error === 'string') {
                    errorMessage = json.error;
                } else if (typeof json.error.message === 'string') {
                    errorMessage = json.error.message;
                    if (json.error.code) {
                        errorMessage = `[${json.error.code}] ${errorMessage}`;
                    }
                } else {
                    errorMessage = JSON.stringify(json.error);
                }
            } else if (json.message && typeof json.message === 'string') {
                errorMessage = json.message;
            }
        }
        if (!errorMessage && rawResponseBody) {
            errorMessage = rawResponseBody.trim();
        }
        return { modelAnswer: null, thinking: null, toolCalls: [], errorMessage };
    }

    if (!json || typeof json !== 'object') {
        // 如果不是 JSON，但有响应文本
        if (rawResponseBody && rawResponseBody.trim()) {
            return {
                modelAnswer: rawResponseBody.trim(),
                thinking: null,
                toolCalls: [],
                errorMessage: null
            };
        }
        return { modelAnswer: null, thinking: null, toolCalls: [], errorMessage: null };
    }

    // 2. 本系统后端 monitor.rs 聚合后的流式格式：
    // { content: "...", thinking: "...", tool_calls: [...] }
    if (typeof json.content === 'string' && json.content.trim()) {
        modelAnswer = json.content;
    }
    if (typeof json.thinking === 'string' && json.thinking.trim()) {
        thinking = json.thinking;
    }
    if (Array.isArray(json.tool_calls)) {
        for (const tc of json.tool_calls) {
            if (tc && typeof tc === 'object') {
                const name = tc.function?.name || tc.name || 'unknown_tool';
                const args = tc.function?.arguments || tc.args || tc.input;
                toolCalls.push({
                    name,
                    args: typeof args === 'string' ? args : args ? JSON.stringify(args) : undefined
                });
            }
        }
    }

    // 3. OpenAI 原生非流式格式：choices[0].message
    if (!modelAnswer && Array.isArray(json.choices) && json.choices.length > 0) {
        const choice = json.choices[0];
        if (choice?.message) {
            const msg = choice.message;
            if (typeof msg.content === 'string') {
                modelAnswer = msg.content;
            }
            if (typeof msg.reasoning_content === 'string') {
                thinking = msg.reasoning_content;
            } else if (typeof msg.reasoning === 'string') {
                thinking = msg.reasoning;
            }
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    const name = tc.function?.name || tc.name || 'tool';
                    const args = tc.function?.arguments;
                    toolCalls.push({ name, args });
                }
            }
        } else if (typeof choice?.text === 'string') {
            modelAnswer = choice.text;
        }
    }

    // 4. Claude 原生非流式格式：content: [{ type: "text", text: "..." }]
    if (!modelAnswer && Array.isArray(json.content)) {
        const texts: string[] = [];
        const thinkings: string[] = [];
        for (const block of json.content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text' && typeof block.text === 'string') {
                texts.push(block.text);
            } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                thinkings.push(block.thinking);
            } else if (block.type === 'tool_use') {
                const name = block.name || 'tool';
                const args = block.input ? JSON.stringify(block.input) : undefined;
                toolCalls.push({ name, args });
            }
        }
        if (texts.length > 0) modelAnswer = texts.join('\n');
        if (thinkings.length > 0) thinking = thinkings.join('\n');
    }

    // 5. Gemini 原生非流式格式：candidates[0].content.parts
    if (!modelAnswer && Array.isArray(json.candidates) && json.candidates.length > 0) {
        const candidate = json.candidates[0];
        if (candidate?.content && Array.isArray(candidate.content.parts)) {
            const texts: string[] = [];
            for (const part of candidate.content.parts) {
                if (part && typeof part.text === 'string') {
                    if (part.thought) {
                        thinking = thinking ? `${thinking}\n${part.text}` : part.text;
                    } else {
                        texts.push(part.text);
                    }
                } else if (part?.functionCall) {
                    const name = part.functionCall.name || 'function';
                    const args = part.functionCall.args ? JSON.stringify(part.functionCall.args) : undefined;
                    toolCalls.push({ name, args });
                }
            }
            if (texts.length > 0) modelAnswer = texts.join('\n');
        }
    }

    // 6. 图像生成接口格式：data: [{ url: "..." }]
    if (!modelAnswer && Array.isArray(json.data) && json.data.length > 0) {
        const img = json.data[0];
        if (img?.url) {
            modelAnswer = `[生成的图片: ${img.url}]`;
        } else if (img?.image) {
            modelAnswer = `[生成的图片数据: ${img.image.mime_type || 'image'} (${img.image.bytes || 0} 字节)]`;
        }
    }

    return { modelAnswer, thinking, toolCalls, errorMessage };
}

/**
 * 主入口：将一条完整的 ProxyRequestLog 报文解析为人眼直观的对话结构
 */
export function parseLogPayload(
    requestBody?: string,
    responseBody?: string,
    status: number = 200,
    logError?: string
): ParsedConversation {
    const reqJson = tryParseJson(requestBody);
    const respJson = tryParseJson(responseBody);
    const isRawJson = Boolean(reqJson || respJson);

    let { userPrompt, systemPrompt, allMessages, isChat } = extractRequestInfo(reqJson);

    // 如果未通过 JSON 提取到提问，尝试截断修复扫描
    if (!userPrompt && requestBody) {
        const fallbackPrompt = fallbackExtractRequestFromTruncated(requestBody);
        if (fallbackPrompt) {
            userPrompt = fallbackPrompt;
            isChat = true;
            allMessages.push({ role: 'user', content: fallbackPrompt });
        }
    }

    const { modelAnswer, thinking, toolCalls, errorMessage } = extractResponseInfo(
        respJson,
        status,
        responseBody,
        logError
    );

    // 如果请求不是标准 chat 格式，但有模型回答或错误，也视为可展示
    if (!isChat && (modelAnswer || errorMessage || toolCalls.length > 0)) {
        isChat = true;
    }

    return {
        isChat,
        userPrompt,
        systemPrompt,
        allMessages,
        thinking,
        modelAnswer,
        toolCalls,
        errorMessage,
        isRawJson
    };
}
