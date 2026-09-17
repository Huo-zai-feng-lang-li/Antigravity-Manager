/**
 * logPayloadParser.ts
 * 负责将原始代理请求/响应报文解析为人类易读的对话结构（用户提问、多模态图片、深度思考、模型回答、工具调用、错误原因）
 * 严格遵循架构防腐与防御性编程原则：纯函数、零状态、多层容错、异常安全降级、极致性能。
 */

export interface MessageItem {
    role: 'user' | 'assistant' | 'system' | 'tool' | string;
    content: string;
}

export interface ToolCallItem {
    name: string;
    args?: string;
}

export interface ImageMediaItem {
    id: string;
    /** 类别：url 外部链接 | base64 完整内联 | truncated 已截断受保护 */
    kind: 'url' | 'base64' | 'truncated';
    /** 仅在完整可用时提供 src，防止损坏的 Base64 塞入 <img> 导致解码崩溃与控制台报错 */
    src?: string;
    mimeType?: string;
    label: string;
    sizeHint?: string;
}

export interface ParsedConversation {
    /** 是否成功提取到对话内容 */
    isChat: boolean;
    /** 用户提问（最后一条用户发言的纯文本，超长 Base64 已提纯脱敏） */
    userPrompt: string | null;
    /** 系统提示词设定（如有） */
    systemPrompt: string | null;
    /** 历史所有对话轮次（用于展开查看上下文） */
    allMessages: MessageItem[];
    /** 提取到的多模态图片列表（支持安全轻量预览与截断保护） */
    images: ImageMediaItem[];
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
    /** 请求报文是否含截断标记（旧版"只存头部"日志的用户输入可能已物理丢失） */
    requestTruncated: boolean;
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
 * 格式化字节大小提示
 */
function formatSizeHint(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 安全解析多模态图片对象，区分完整图片与截断图片（实现极致性能与防御性渲染）
 */
function processImageItem(rawUrlOrData: string, mime?: string, index: number = 0): ImageMediaItem {
    const id = `img-${index}-${Date.now().toString(36)}`;
    const trimmed = (rawUrlOrData || '').trim();

    // 1. 外部 HTTP/HTTPS 图片链接
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return {
            id,
            kind: 'url',
            src: trimmed,
            mimeType: mime || 'image/url',
            label: `图片链接 #${index + 1}`,
            sizeHint: '网络资源'
        };
    }

    // 2. 检测是否为截断损坏的 Base64
    const isTruncated = trimmed.includes('...[truncated ') || trimmed.includes('[truncated');
    if (isTruncated) {
        let detectedMime = mime || 'image/*';
        if (trimmed.startsWith('data:image/')) {
            const endMime = trimmed.indexOf(';');
            if (endMime > 11) {
                detectedMime = trimmed.substring(5, endMime);
            }
        }
        return {
            id,
            kind: 'truncated',
            mimeType: detectedMime,
            label: `多模态图片 #${index + 1} (已截断保护)`,
            sizeHint: '超出日志长度上限 · 仅占位'
        };
    }

    // 3. 完整 Base64 图片
    if (trimmed.startsWith('data:image/')) {
        const endMime = trimmed.indexOf(';');
        const detectedMime = endMime > 11 ? trimmed.substring(5, endMime) : (mime || 'image/png');
        const approxBytes = Math.round((trimmed.length * 3) / 4);
        return {
            id,
            kind: 'base64',
            src: trimmed,
            mimeType: detectedMime,
            label: `内联图片 #${index + 1}`,
            sizeHint: formatSizeHint(approxBytes)
        };
    }

    // 纯 Base64 无 data: 前缀
    if (trimmed.length > 50 && /^[A-Za-z0-9+/=]+$/.test(trimmed.substring(0, 50))) {
        const detectedMime = mime || 'image/png';
        const approxBytes = Math.round((trimmed.length * 3) / 4);
        return {
            id,
            kind: 'base64',
            src: `data:${detectedMime};base64,${trimmed}`,
            mimeType: detectedMime,
            label: `内联图片 #${index + 1}`,
            sizeHint: formatSizeHint(approxBytes)
        };
    }

    // 兜底返回截断保护
    return {
        id,
        kind: 'truncated',
        mimeType: mime || 'image/*',
        label: `图片数据 #${index + 1}`,
        sizeHint: '不可预览'
    };
}

/**
 * 解析单条消息的 content 字段（支持 string、数组、多模态 block、嵌套结构）
 * 并将超长 Base64 抽离为轻量图片元数据列表，确保纯文本复制体验干净整洁
 */
function extractContentAndImages(content: any, globalImages: ImageMediaItem[]): string {
    if (typeof content === 'string') {
        // 如果是包含在文本里的超大 data:image 链接，防止污染提问文本
        if (content.startsWith('data:image/')) {
            const img = processImageItem(content, undefined, globalImages.length);
            globalImages.push(img);
            return `[图片: ${img.mimeType || 'image'}]`;
        }
        return content;
    }

    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const item of content) {
            if (typeof item === 'string') {
                parts.push(item);
            } else if (item && typeof item === 'object') {
                const itemType = String(item.type || '').toLowerCase();

                // 文本内容
                if ((itemType === 'text' || itemType === 'input_text' || itemType === 'output_text') && typeof item.text === 'string') {
                    parts.push(item.text);
                } else if (typeof item.text === 'string') {
                    parts.push(item.text);
                }
                // OpenAI / Responses 格式图片
                else if (itemType === 'image_url' || itemType === 'image' || itemType === 'input_image') {
                    const rawUrl = typeof item.image_url === 'string'
                        ? item.image_url
                        : item.image_url?.url || item.url || item.source?.data;
                    const mime = item.source?.media_type;
                    if (rawUrl) {
                        const img = processImageItem(rawUrl, mime, globalImages.length);
                        globalImages.push(img);
                        parts.push(`[图片: ${img.mimeType || 'image'}]`);
                    } else {
                        parts.push('[图片]');
                    }
                }
                // Claude source 格式
                else if (item.source && (item.source.type === 'base64' || item.source.type === 'url')) {
                    const rawData = item.source.data || item.source.url;
                    const mime = item.source.media_type;
                    if (rawData) {
                        const img = processImageItem(rawData, mime, globalImages.length);
                        globalImages.push(img);
                        parts.push(`[图片: ${img.mimeType || 'image'}]`);
                    } else {
                        parts.push('[图片]');
                    }
                }
                // Gemini inlineData 格式
                else if (item.inlineData && item.inlineData.data) {
                    const rawData = item.inlineData.data;
                    const mime = item.inlineData.mimeType;
                    const img = processImageItem(rawData, mime, globalImages.length);
                    globalImages.push(img);
                    parts.push(`[图片: ${img.mimeType || 'image'}]`);
                }
                // 音频
                else if (itemType === 'input_audio') {
                    parts.push('[音频]');
                }
                // 嵌套 content
                else if (item.content) {
                    const subText = extractContentAndImages(item.content, globalImages);
                    if (subText) parts.push(subText);
                }
            }
        }
        return parts.join('\n');
    }

    if (content && typeof content === 'object') {
        if (typeof content.text === 'string') return content.text;
        if (content.content) return extractContentAndImages(content.content, globalImages);
    }

    return '';
}

/**
 * 递归解析并标准化处理单条消息或消息列表
 */
function processMessageBlock(
    item: any,
    allMessages: MessageItem[],
    globalImages: ImageMediaItem[],
    onUserPrompt: (text: string) => void,
    onSystemPrompt: (text: string) => void
) {
    if (!item || typeof item !== 'object') return;

    // 1. 如果带有 role 或者是 message 类型
    const rawRole = item.role || (item.type === 'message' ? 'user' : null);
    if (rawRole) {
        const role = String(rawRole).toLowerCase();
        const text = extractContentAndImages(item.content ?? item.parts ?? item.text, globalImages);
        allMessages.push({ role, content: text });

        if (role === 'system' || role === 'developer') {
            onSystemPrompt(text);
        } else if (role === 'user') {
            onUserPrompt(text);
        }
        return;
    }

    // 2. WebSocket / Responses 函数调用与执行返回
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const name = item.name || 'tool';
        const args = item.arguments || (item.input ? JSON.stringify(item.input) : '');
        allMessages.push({ role: 'assistant', content: `[调用工具: ${name}]\n${args}` });
        return;
    }

    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        const text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '');
        allMessages.push({ role: 'tool', content: `[工具返回: ${item.call_id || 'call'}]\n${text}` });
        return;
    }

    // 3. 如果 item 本身就是 input_text 或 content block
    if (item.type === 'input_text' || item.type === 'output_text' || item.type === 'text' || item.text) {
        const text = extractContentAndImages([item], globalImages);
        if (text) {
            allMessages.push({ role: 'user', content: text });
            onUserPrompt(text);
        }
        return;
    }

    // 4. 如果包含嵌套的 content / parts / items 数组
    if (Array.isArray(item.content)) {
        for (const sub of item.content) {
            processMessageBlock(sub, allMessages, globalImages, onUserPrompt, onSystemPrompt);
        }
    }
}

/**
 * 从 JSON 对象中提取请求信息（用户提问、系统设定、多模态图片、完整消息流）
 */
function extractRequestInfo(json: any): {
    userPrompt: string | null;
    systemPrompt: string | null;
    allMessages: MessageItem[];
    images: ImageMediaItem[];
    isChat: boolean;
} {
    const allMessages: MessageItem[] = [];
    const images: ImageMediaItem[] = [];
    let systemPrompt: string | null = null;
    let userPrompt: string | null = null;

    const handleSystem = (text: string) => {
        if (!text) return;
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
    };

    const handleUser = (text: string) => {
        if (!text) return;
        userPrompt = text; // 覆盖保留最后一次用户发言
    };

    if (!json || typeof json !== 'object') {
        return { userPrompt: null, systemPrompt: null, allMessages: [], images: [], isChat: false };
    }

    // 1. 标准 messages 数组（OpenAI / Claude / Responses 格式）
    if (Array.isArray(json.messages)) {
        for (const msg of json.messages) {
            processMessageBlock(msg, allMessages, images, handleUser, handleSystem);
        }
    }

    // 2. Claude system 顶层字段（Claude 常见规范）
    if (json.system) {
        const claudeSystem = extractContentAndImages(json.system, images);
        handleSystem(claudeSystem);
    }

    // 3. Responses API instructions 字段
    if (json.instructions && typeof json.instructions === 'string') {
        handleSystem(json.instructions);
    }

    // 4. OpenAI Responses API input 字段（支持字符串、消息对象、消息列表）
    if (json.input !== undefined && json.input !== null) {
        if (typeof json.input === 'string') {
            const text = json.input.trim();
            if (text) {
                allMessages.push({ role: 'user', content: text });
                handleUser(text);
            }
        } else if (Array.isArray(json.input)) {
            for (const item of json.input) {
                if (typeof item === 'string') {
                    allMessages.push({ role: 'user', content: item });
                    handleUser(item);
                } else {
                    processMessageBlock(item, allMessages, images, handleUser, handleSystem);
                }
            }
        } else if (typeof json.input === 'object') {
            processMessageBlock(json.input, allMessages, images, handleUser, handleSystem);
        }
    }

    // 5. Gemini 原生 contents 数组格式
    if (!userPrompt && Array.isArray(json.contents)) {
        for (const item of json.contents) {
            processMessageBlock(item, allMessages, images, handleUser, handleSystem);
        }
    }

    // 6. 顶层 prompt 字段（Completions / 图像生成接口）
    if (!userPrompt && json.prompt) {
        const text = extractContentAndImages(json.prompt, images);
        if (text) {
            allMessages.push({ role: 'user', content: text });
            handleUser(text);
        }
    }

    const isChat = Boolean(userPrompt || allMessages.length > 0 || images.length > 0);
    return { userPrompt, systemPrompt, allMessages, images, isChat };
}

/**
 * 从截断/残缺报文中抢救多模态图片。
 *
 * 报文按"头部 + 尾部"落库后 JSON 已非法，无法走结构化解析：
 * - 外链图片 URL 通常很短，尾部片段里可能完整保留，可直接预览；
 * - 内联 base64 图片体积大，物理上不可能完整保留，只能给出占位卡片，
 *   数量综合 data: 前缀、MIME 标记与后端截断标记 images=N 三方估计。
 */
function rescueImagesFromTruncated(text: string): ImageMediaItem[] {
    if (!text || typeof text !== 'string') return [];
    const items: ImageMediaItem[] = [];
    const MAX_IMAGES = 8;

    const decodeJsonString = (raw: string): string => {
        try {
            return JSON.parse(`"${raw}"`);
        } catch {
            return raw.replace(/\\u0026/g, '&').replace(/\\n/g, '\n').replace(/\\"/g, '"');
        }
    };

    // 1. 外链图片：OpenAI image_url / Claude source(url) / Gemini fileData
    const urlPatterns: RegExp[] = [
        /"image_url"\s*:\s*\{\s*"url"\s*:\s*"(https?:[^"\\]+)"/g,
        /"source"\s*:\s*\{\s*"type"\s*:\s*"url"[\s\S]*?"url"\s*:\s*"(https?:[^"\\]+)"/g,
        /"file(?:_)?[Dd]ata"\s*:\s*\{[\s\S]*?"file(?:_)?[Uu]ri"\s*:\s*"(https?:[^"\\]+)"/g,
    ];
    const seenUrls = new Set<string>();
    for (const pattern of urlPatterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) && items.length < MAX_IMAGES) {
            const url = decodeJsonString(match[1]);
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            items.push({
                id: `rescue-url-${items.length}`,
                kind: 'url',
                src: url,
                mimeType: 'image/url',
                label: `图片链接 #${items.length + 1}`,
                sizeHint: '网络资源'
            });
        }
    }

    // 2. 完整内联 data URI（必须以引号收尾，尾部保留区内的小图可完整还原）
    const completeDataUris: string[] = [];
    const completeDataRe = /(data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+)"/g;
    let dataMatch: RegExpExecArray | null;
    while ((dataMatch = completeDataRe.exec(text)) && completeDataUris.length < MAX_IMAGES) {
        if (!completeDataUris.includes(dataMatch[1])) completeDataUris.push(dataMatch[1]);
    }
    for (const uri of completeDataUris) {
        items.push(processImageItem(uri, undefined, items.length));
    }

    // 3. 残缺内联图片数量估计（三种格式的标记互不重叠，取各自计数后与后端标记取最大）
    const dataPrefixCount = (text.match(/data:image\/(?:png|jpeg|jpg|webp|gif);base64,/g) || []).length;
    const brokenDataCount = Math.max(0, dataPrefixCount - completeDataUris.length);
    const mimeMarkCount = (text.match(/"(?:media_type|mime_?[Tt]ype)"\s*:\s*"image\/(?:png|jpeg|jpg|webp|gif)"/g) || []).length;
    const markerMatch = text.match(/\[truncated[^\]]*?;images=(\d+)/);
    const markerCount = markerMatch ? parseInt(markerMatch[1], 10) || 0 : 0;
    const inlineTotal = Math.max(brokenDataCount + completeDataUris.length, mimeMarkCount, markerCount);
    const placeholderCount = Math.max(
        0,
        Math.min(MAX_IMAGES - items.length, inlineTotal - completeDataUris.length)
    );
    for (let i = 0; i < placeholderCount; i++) {
        items.push({
            id: `rescue-broken-${i}`,
            kind: 'truncated',
            mimeType: 'image/*',
            label: `多模态图片 #${items.length + 1} (已截断保护)`,
            sizeHint: '超出日志长度上限 · 仅占位'
        });
    }

    return items;
}

/** 解码 JSON 字符串片段为可读文本 */
function decodeJsonText(raw: string): string {
    try {
        return JSON.parse(`"${raw}"`);
    } catch {
        return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t');
    }
}

/**
 * 正则回退扫描：当请求报文被截断导致非合法 JSON 时的抢救机制
 *
 * 深度覆盖 "role":"user"（content 字符串/数组）、Responses API "input"、
 * "prompt" 等常见格式，同时抢救尾部片段中的多模态图片。
 */
function fallbackExtractRequestFromTruncated(text: string): {
    prompt: string | null;
    images: ImageMediaItem[];
} {
    if (!text || typeof text !== 'string') return { prompt: null, images: [] };

    let prompt: string | null = null;

    // 1. 尝试寻找最后一个 "role": "user"
    const userRoleIdx = Math.max(text.lastIndexOf('"role": "user"'), text.lastIndexOf('"role":"user"'));
    if (userRoleIdx !== -1) {
        // 只在 user role 之后的有限窗口内寻找，避免抓到后续 assistant 消息
        const afterUser = text.substring(userRoleIdx, userRoleIdx + 6000);

        // 1a. content 为字符串："content":"..."
        const contentMatch = afterUser.match(/"content":\s*"((?:[^"\\]|\\.)*)"/);
        if (contentMatch && contentMatch[1]) {
            prompt = decodeJsonText(contentMatch[1]);
        }
        // 1b. 未闭合双引号截断（content 字符串被切断）
        if (!prompt) {
            const unclosed = afterUser.match(/"content":\s*"([^"\\]*?)(?:\.\.\.\[truncated|$)/);
            if (unclosed && unclosed[1]) prompt = decodeJsonText(unclosed[1]);
        }
        // 1c. content 为数组：{"type":"input_text","text":"..."} / {"type":"text","text":"..."}
        if (!prompt) {
            const arrayTextMatch = afterUser.match(
                /"(?:input_text|text)"\s*:\s*"((?:[^"\\]|\\.)*)"/
            );
            if (arrayTextMatch && arrayTextMatch[1]) prompt = decodeJsonText(arrayTextMatch[1]);
        }
        if (!prompt) {
            const unclosedArray = afterUser.match(/"(?:input_text|text)"\s*:\s*"([^"\\]*?)(?:\.\.\.\[truncated|$)/);
            if (unclosedArray && unclosedArray[1]) prompt = decodeJsonText(unclosedArray[1]);
        }
    }

    // 2. 尝试扫描 Responses API 的 "input" 字段（字符串形式）
    if (!prompt) {
        const inputIdx = Math.max(text.lastIndexOf('"input": "'), text.lastIndexOf('"input":"'));
        if (inputIdx !== -1) {
            const afterInput = text.substring(inputIdx);
            const match = afterInput.match(/"input":\s*"((?:[^"\\]|\\.)*)"/);
            if (match && match[1]) {
                prompt = decodeJsonText(match[1]);
            }
            if (!prompt) {
                const unclosed = afterInput.match(/"input":\s*"([^"\\]*?)(?:\.\.\.\[truncated|$)/);
                if (unclosed && unclosed[1]) prompt = decodeJsonText(unclosed[1]);
            }
        }
    }

    // 3. 尝试扫描 "prompt": "..."
    if (!prompt) {
        const promptIdx = Math.max(text.lastIndexOf('"prompt": "'), text.lastIndexOf('"prompt":"'));
        if (promptIdx !== -1) {
            const afterPrompt = text.substring(promptIdx);
            const match = afterPrompt.match(/"prompt":\s*"((?:[^"\\]|\\.)*)"/);
            if (match && match[1]) prompt = decodeJsonText(match[1]);
        }
    }

    return { prompt, images: rescueImagesFromTruncated(text) };
}

/**
 * 递归解析 Responses API 或 WebSocket 传输的 output items 列表
 * 支持 function_call, custom_tool_call, reasoning, message(output_text)
 */
function parseOutputItems(items: any[], toolCalls: ToolCallItem[]): {
    answer: string | null;
    thinking: string | null;
} {
    const texts: string[] = [];
    const thinkings: string[] = [];

    if (!Array.isArray(items)) return { answer: null, thinking: null };

    for (const item of items) {
        if (!item || typeof item !== 'object') continue;

        // 1. 函数/工具调用（WebSocket / Responses）
        const isToolCall = item.type === 'function_call' ||
            item.type === 'custom_tool_call' ||
            item.type === 'local_shell_call' ||
            item.type === 'web_search_call';

        if (isToolCall) {
            const name = item.name || (item.type === 'local_shell_call' ? 'shell' : item.type === 'web_search_call' ? 'google_search' : 'tool');
            let args = item.arguments;
            if (!args && item.input) {
                args = typeof item.input === 'string' ? item.input : JSON.stringify(item.input);
            }
            if (!args && item.action) {
                args = JSON.stringify(item.action);
            }
            toolCalls.push({
                name,
                args: typeof args === 'string' ? args : args ? JSON.stringify(args) : undefined
            });
            continue;
        }

        // 2. 深度思考过程（Reasoning）
        if (item.type === 'reasoning') {
            if (Array.isArray(item.summary)) {
                for (const s of item.summary) {
                    if (typeof s?.text === 'string') thinkings.push(s.text);
                }
            } else if (typeof item.text === 'string') {
                thinkings.push(item.text);
            }
            continue;
        }

        // 3. 模型回答消息
        if (item.type === 'message' || item.role === 'assistant') {
            if (Array.isArray(item.content)) {
                for (const c of item.content) {
                    if (!c || typeof c !== 'object') continue;
                    const cType = String(c.type || '').toLowerCase();
                    if (cType === 'output_text' || cType === 'text') {
                        if (typeof c.text === 'string') texts.push(c.text);
                    } else if (cType === 'reasoning' || cType === 'thinking') {
                        if (typeof c.text === 'string') thinkings.push(c.text);
                        else if (typeof c.thinking === 'string') thinkings.push(c.thinking);
                    } else if (typeof c.text === 'string') {
                        texts.push(c.text);
                    }
                }
            } else if (typeof item.content === 'string') {
                texts.push(item.content);
            }
            if (typeof item.reasoning === 'string') {
                thinkings.push(item.reasoning);
            }
        }
    }

    return {
        answer: texts.length > 0 ? texts.join('\n') : null,
        thinking: thinkings.length > 0 ? thinkings.join('\n') : null
    };
}

/**
 * 响应截断回退扫描：当响应报文被 16KB 截断导致 JSON 残缺时的抢救机制
 */
function fallbackExtractResponseFromTruncated(text: string): string | null {
    if (!text || typeof text !== 'string') return null;

    // 1. 尝试匹配 "content": "..."
    const contentIdx = Math.max(text.lastIndexOf('"content": "'), text.lastIndexOf('"content":"'));
    if (contentIdx !== -1) {
        const after = text.substring(contentIdx);
        const match = after.match(/"content":\s*"((?:[^"\\]|\\.)*)"/);
        if (match && match[1]) {
            try {
                return JSON.parse(`"${match[1]}"`);
            } catch {
                return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
            }
        }
    }

    // 2. 尝试匹配 WebSocket 的 output_text
    const outputTextIdx = Math.max(text.lastIndexOf('"output_text"'), text.lastIndexOf('"text":'));
    if (outputTextIdx !== -1) {
        const after = text.substring(outputTextIdx);
        const match = after.match(/"text":\s*"((?:[^"\\]|\\.)*)"/);
        if (match && match[1]) {
            try {
                return JSON.parse(`"${match[1]}"`);
            } catch {
                return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
            }
        }
        const unclosed = after.match(/"text":\s*"([^"\\]*?)(?:\.\.\.\[truncated|$)/);
        if (unclosed && unclosed[1]) {
            return unclosed[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
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
                } else {
                    errorMessage = JSON.stringify(json.error);
                }
            } else if (typeof json.message === 'string') {
                errorMessage = json.message;
            } else if (typeof json.detail === 'string') {
                errorMessage = json.detail;
            }
        }
        if (!errorMessage && rawResponseBody) {
            errorMessage = rawResponseBody.substring(0, 1000);
        }
        return { modelAnswer: null, thinking: null, toolCalls: [], errorMessage };
    }

    // 如果响应体本身解析失败，但为纯文本回答
    if (!json) {
        if (rawResponseBody && rawResponseBody.trim() && !rawResponseBody.trim().startsWith('<')) {
            return {
                modelAnswer: rawResponseBody.trim(),
                thinking: null,
                toolCalls: [],
                errorMessage: null
            };
        }
        return { modelAnswer: null, thinking: null, toolCalls: [], errorMessage: null };
    }

    // 2. WebSocket / Responses API 输出格式深度支持：
    // A. 顶层直接为 Array（如 WebSocket 会话完成后存入的 completed_output 数组）
    if (Array.isArray(json) && json.length > 0) {
        const { answer, thinking: parsedThinking } = parseOutputItems(json, toolCalls);
        if (answer) modelAnswer = answer;
        if (parsedThinking) thinking = parsedThinking;
    }

    // B. WebSocket response.completed 事件对象：{ type: "response.completed", response: { output: [...] } }
    if (!modelAnswer && json.response?.output && Array.isArray(json.response.output)) {
        const { answer, thinking: parsedThinking } = parseOutputItems(json.response.output, toolCalls);
        if (answer) modelAnswer = answer;
        if (parsedThinking) thinking = parsedThinking;
    }

    // C. Responses API 标准响应：{ output: [...] }
    if (!modelAnswer && Array.isArray(json.output) && json.output.length > 0) {
        const { answer, thinking: parsedThinking } = parseOutputItems(json.output, toolCalls);
        if (answer) modelAnswer = answer;
        if (parsedThinking) thinking = parsedThinking;
    }

    // D. 单个 WebSocket 输出事件：{ type: "response.output_item.done", item: { ... } }
    if (!modelAnswer && json.item && typeof json.item === 'object') {
        const { answer, thinking: parsedThinking } = parseOutputItems([json.item], toolCalls);
        if (answer) modelAnswer = answer;
        if (parsedThinking) thinking = parsedThinking;
    }

    // E. 单个 WebSocket 文本事件：{ type: "response.output_text.done", text: "..." }
    if (!modelAnswer && json.type === 'response.output_text.done' && typeof json.text === 'string') {
        modelAnswer = json.text;
    }

    // 3. 本系统后端 monitor.rs 聚合后的流式格式：
    // { content: "...", thinking: "...", tool_calls: [...] }
    if (!modelAnswer && typeof json.content === 'string' && json.content.trim()) {
        modelAnswer = json.content;
    }
    if (!thinking && typeof json.thinking === 'string' && json.thinking.trim()) {
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

    // 4. OpenAI 原生非流式格式：choices[0].message
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

    // 5. Claude 原生非流式格式：content: [{ type: "text", text: "..." }]
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

    // 6. Gemini 原生非流式格式：candidates[0].content.parts
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

    // 7. 图像生成接口格式：data: [{ url: "..." }]
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

    let { userPrompt, systemPrompt, allMessages, images, isChat } = extractRequestInfo(reqJson);

    // 请求体含截断标记时，尾部的用户输入/图片可能在结构化解析中丢失，
    // 即使 reqJson 侥幸解析成功（头部片段补全），也要对全文做一次抢救扫描。
    const requestTruncated = Boolean(requestBody && requestBody.includes('[truncated'));
    if (requestBody && (!userPrompt || requestTruncated || images.length === 0)) {
        const fallback = fallbackExtractRequestFromTruncated(requestBody);
        if (!userPrompt && fallback.prompt) {
            userPrompt = fallback.prompt;
            isChat = true;
            allMessages.push({ role: 'user', content: fallback.prompt });
        }
        if (fallback.images.length > 0) {
            const existingKeys = new Set(images.map(img => img.src || `${img.kind}:${img.mimeType}`));
            for (const img of fallback.images) {
                const key = img.src || `${img.kind}:${img.mimeType}`;
                if (!existingKeys.has(key)) {
                    images.push(img);
                    existingKeys.add(key);
                }
            }
            isChat = true;
        }
    }

    let { modelAnswer, thinking, toolCalls, errorMessage } = extractResponseInfo(
        respJson,
        status,
        responseBody,
        logError
    );

    // 如果未通过常规 JSON 提取到模型回答，且响应体可能因截断损坏，执行截断防御扫描
    if (!modelAnswer && responseBody && (responseBody.includes('[truncated') || !respJson)) {
        const fallbackAns = fallbackExtractResponseFromTruncated(responseBody);
        if (fallbackAns) {
            modelAnswer = fallbackAns;
        }
    }

    // 如果请求不是标准 chat 格式，但有模型回答或错误，也视为可展示
    if (!isChat && (modelAnswer || errorMessage || toolCalls.length > 0)) {
        isChat = true;
    }

    return {
        isChat,
        userPrompt,
        systemPrompt,
        allMessages,
        images,
        thinking,
        modelAnswer,
        toolCalls,
        errorMessage,
        isRawJson,
        requestTruncated
    };
}
