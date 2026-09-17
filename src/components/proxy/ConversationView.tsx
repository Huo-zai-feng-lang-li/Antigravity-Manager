import React, { useState } from 'react';
import {
    User,
    Sparkles,
    Brain,
    Wrench,
    Copy,
    CheckCircle,
    ChevronDown,
    ChevronUp,
    AlertTriangle,
    Sliders,
    MessageSquare,
    Image as ImageIcon,
    Eye,
    ShieldCheck,
    X
} from 'lucide-react';
import { ParsedConversation } from './logPayloadParser';
import { copyToClipboard } from '../../utils/clipboard';

interface ConversationViewProps {
    parsed: ParsedConversation;
    logId: string;
    t: any;
    onSwitchToRaw?: () => void;
}

export const ConversationView: React.FC<ConversationViewProps> = ({
    parsed,
    logId,
    t,
    onSwitchToRaw
}) => {
    const [copiedKey, setCopiedKey] = useState<string | null>(null);
    const [isThinkingOpen, setIsThinkingOpen] = useState(false);
    const [isSystemOpen, setIsSystemOpen] = useState(false);
    const [isHistoryOpen, setIsHistoryOpen] = useState(false);
    const [previewModalImg, setPreviewModalImg] = useState<{ src: string; label: string } | null>(null);

    const handleCopy = async (text: string, key: string) => {
        const success = await copyToClipboard(text);
        if (success) {
            setCopiedKey(key);
            setTimeout(() => {
                setCopiedKey(prev => (prev === key ? null : prev));
            }, 2000);
        }
    };

    // 如果不是对话类型，且没有可展示内容，友好提示并引导切到原始报文
    if (!parsed.isChat && !parsed.errorMessage && !parsed.modelAnswer) {
        return (
            <div className="flex flex-col items-center justify-center p-8 bg-gray-50 dark:bg-base-200 rounded-xl border border-dashed border-gray-200 dark:border-base-300 text-center">
                <Sliders size={36} className="text-gray-400 mb-3" />
                <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">
                    {t('monitor.conversation.non_chat_title', '非聊天对话接口')}
                </h4>
                <p className="text-xs text-gray-500 dark:text-gray-400 max-w-sm mb-4">
                    {t('monitor.conversation.non_chat_desc', '该请求为系统探测、模型列表或专用协议接口，未包含标准对话问答。')}
                </p>
                {onSwitchToRaw && (
                    <button
                        type="button"
                        onClick={onSwitchToRaw}
                        className="btn btn-sm btn-outline btn-primary gap-2"
                    >
                        {t('monitor.conversation.view_raw_payload', '查看原始报文')}
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className="space-y-4 relative">
            {/* 1. 系统设定（System Prompt） - 折叠展示 */}
            {parsed.systemPrompt && (
                <div className="bg-gray-50 dark:bg-base-200 rounded-xl border border-gray-200 dark:border-base-300 overflow-hidden text-xs">
                    <button
                        type="button"
                        onClick={() => setIsSystemOpen(!isSystemOpen)}
                        className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-100/70 dark:bg-base-300/50 hover:bg-gray-100 dark:hover:bg-base-300 transition-colors text-gray-600 dark:text-gray-400"
                    >
                        <span className="flex items-center gap-2 font-semibold">
                            <Sliders size={14} className="text-purple-500" />
                            {t('monitor.conversation.system_prompt', '系统设定与提示词 (System Prompt)')}
                        </span>
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] text-gray-400">
                                {parsed.systemPrompt.length} {t('monitor.conversation.chars', '字符')}
                            </span>
                            {isSystemOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </div>
                    </button>
                    {isSystemOpen && (
                        <div className="p-4 border-t border-gray-200 dark:border-base-300 bg-white dark:bg-base-100 max-h-60 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-gray-700 dark:text-gray-300 leading-relaxed">
                            {parsed.systemPrompt}
                        </div>
                    )}
                </div>
            )}

            {/* 2. 用户提问卡片（含多模态图片高性能预览） */}
            {(parsed.userPrompt || parsed.images.length > 0) && (
                <div className="bg-blue-50/50 dark:bg-blue-950/20 rounded-xl border border-blue-200/70 dark:border-blue-900/50 overflow-hidden shadow-xs">
                    <div className="flex items-center justify-between px-4 py-2.5 bg-blue-100/50 dark:bg-blue-900/30 border-b border-blue-200/50 dark:border-blue-900/40">
                        <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300 font-bold text-xs">
                            <span className="p-1 rounded-md bg-blue-200 dark:bg-blue-800/60">
                                <User size={14} />
                            </span>
                            <span>{t('monitor.conversation.user_prompt', '用户提问 (Prompt)')}</span>
                            {parsed.images.length > 0 && (
                                <span className="badge badge-sm badge-info badge-outline gap-1 text-[10px]">
                                    <ImageIcon size={10} />
                                    {parsed.images.length} {t('monitor.conversation.multimodal_images', '张图片')}
                                </span>
                            )}
                        </div>
                        {parsed.userPrompt && (
                            <button
                                type="button"
                                onClick={() => handleCopy(parsed.userPrompt || '', `user-${logId}`)}
                                className="btn btn-ghost btn-xs gap-1 text-blue-700 dark:text-blue-300 hover:bg-blue-200/50 dark:hover:bg-blue-800/40"
                                title={t('proxy.config.btn_copy')}
                            >
                                {copiedKey === `user-${logId}` ? (
                                    <>
                                        <CheckCircle size={12} className="text-green-500" />
                                        <span className="text-[10px] text-green-600 dark:text-green-400 font-semibold">
                                            {t('proxy.config.btn_copied', '已复制')}
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <Copy size={12} />
                                        <span className="text-[10px]">{t('proxy.config.btn_copy', '复制问题')}</span>
                                    </>
                                )}
                            </button>
                        )}
                    </div>

                    <div className="p-4 space-y-3">
                        {/* 提问纯文本（Base64已自动脱敏替换，轻量不卡顿） */}
                        {parsed.userPrompt ? (
                            <div className="text-xs leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap font-sans select-text max-h-[420px] overflow-y-auto">
                                {parsed.userPrompt}
                            </div>
                        ) : parsed.allMessages.length > 0 ? (
                            <div className="text-xs italic text-gray-500 dark:text-gray-400">
                                {t('monitor.conversation.multi_turn_notice', '本轮无单一用户提问（包含工具交互或多轮上下文，详情见下方展开）')}
                            </div>
                        ) : null}

                        {/* 多模态图片预览区（高性能缩略图 + 截断保护） */}
                        {parsed.images.length > 0 && (
                            <div className="pt-2 border-t border-blue-200/40 dark:border-blue-900/40">
                                <div className="flex items-center gap-1 text-[11px] font-semibold text-blue-800/90 dark:text-blue-300 mb-2">
                                    <ImageIcon size={13} />
                                    <span>{t('monitor.conversation.multimodal_images', '附带图片 (多模态)')}</span>
                                </div>
                                <div className="flex flex-wrap gap-2.5 items-center">
                                    {parsed.images.map((img) => {
                                        // A. 完整图片：渲染轻量缩略图并支持放大
                                        if (img.kind === 'url' || (img.kind === 'base64' && img.src)) {
                                            return (
                                                <div
                                                    key={img.id}
                                                    onClick={() => setPreviewModalImg({ src: img.src!, label: img.label })}
                                                    className="group relative w-20 h-20 rounded-lg overflow-hidden border border-blue-200 dark:border-blue-800 bg-black/5 dark:bg-black/30 cursor-pointer shadow-xs hover:shadow-sm transition-all"
                                                    title={t('monitor.conversation.click_to_zoom', '点击查看大图')}
                                                >
                                                    <img
                                                        src={img.src}
                                                        alt={img.label}
                                                        loading="lazy"
                                                        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                                                    />
                                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-white text-[10px]">
                                                        <Eye size={14} />
                                                        <span className="mt-0.5">{img.sizeHint}</span>
                                                    </div>
                                                </div>
                                            );
                                        }

                                        // B. 截断受保护图片：渲染防御性安全卡片，杜绝破图崩溃
                                        return (
                                            <div
                                                key={img.id}
                                                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-100/70 dark:bg-blue-900/40 border border-dashed border-blue-300 dark:border-blue-700 text-xs"
                                                title={t('monitor.conversation.image_truncated', '图片数据已截断保护 (超出 16KB)')}
                                            >
                                                <ShieldCheck size={16} className="text-blue-600 dark:text-blue-400 flex-shrink-0" />
                                                <div className="flex flex-col">
                                                    <span className="font-semibold text-blue-950 dark:text-blue-100 text-[11px]">
                                                        {img.label}
                                                    </span>
                                                    <span className="text-[10px] text-blue-700/80 dark:text-blue-300/80">
                                                        {img.sizeHint || t('monitor.conversation.image_truncated')}
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* 3. 多轮历史对话上下文展开（如果有大于 1 条消息） */}
            {parsed.allMessages.length > 1 && (
                <div className="bg-gray-50 dark:bg-base-200 rounded-xl border border-gray-200 dark:border-base-300 overflow-hidden text-xs">
                    <button
                        type="button"
                        onClick={() => setIsHistoryOpen(!isHistoryOpen)}
                        className="w-full flex items-center justify-between px-4 py-2 bg-gray-100/50 dark:bg-base-300/40 hover:bg-gray-100 dark:hover:bg-base-300 transition-colors text-gray-600 dark:text-gray-400"
                    >
                        <span className="flex items-center gap-2 font-medium">
                            <MessageSquare size={14} className="text-blue-500" />
                            {t('monitor.conversation.history_context', '完整会话上下文')} ({parsed.allMessages.length} {t('monitor.conversation.messages_count', '条消息')})
                        </span>
                        {isHistoryOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                    {isHistoryOpen && (
                        <div className="p-3 border-t border-gray-200 dark:border-base-300 space-y-2 bg-white dark:bg-base-100 max-h-72 overflow-y-auto">
                            {parsed.allMessages.map((msg, idx) => (
                                <div key={idx} className="p-2.5 rounded-lg bg-gray-50 dark:bg-base-200 border border-gray-100 dark:border-base-300">
                                    <div className="text-[10px] font-bold uppercase text-gray-500 mb-1 flex items-center gap-1.5">
                                        <span className={`w-1.5 h-1.5 rounded-full ${msg.role === 'user' ? 'bg-blue-500' : msg.role === 'assistant' ? 'bg-emerald-500' : msg.role === 'tool' ? 'bg-amber-500' : 'bg-purple-500'}`} />
                                        {msg.role}
                                    </div>
                                    <div className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
                                        {msg.content}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* 4. 深度思考过程（Thinking / Reasoning） - 类似 Claude / DeepSeek R1 */}
            {parsed.thinking && (
                <div className="bg-amber-50/40 dark:bg-amber-950/20 rounded-xl border border-amber-200/60 dark:border-amber-900/40 overflow-hidden text-xs">
                    <button
                        type="button"
                        onClick={() => setIsThinkingOpen(!isThinkingOpen)}
                        className="w-full flex items-center justify-between px-4 py-2.5 bg-amber-100/50 dark:bg-amber-900/30 hover:bg-amber-100/70 dark:hover:bg-amber-900/50 transition-colors text-amber-800 dark:text-amber-300 font-semibold"
                    >
                        <span className="flex items-center gap-2">
                            <Brain size={14} className="text-amber-600 dark:text-amber-400" />
                            {t('monitor.conversation.thinking', '深度思考过程 (Thinking / Reasoning)')}
                        </span>
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] text-amber-700/80 dark:text-amber-400/80 font-normal">
                                {isThinkingOpen ? t('common.collapse', '折叠') : `${t('common.expand', '展开')} (${parsed.thinking.length} ${t('monitor.conversation.chars', '字符')})`}
                            </span>
                            {isThinkingOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </div>
                    </button>
                    {isThinkingOpen && (
                        <div className="p-4 border-t border-amber-200/50 dark:border-amber-900/40 bg-white/60 dark:bg-base-100/60 max-h-72 overflow-y-auto whitespace-pre-wrap text-xs font-sans text-amber-950 dark:text-amber-200/90 leading-relaxed select-text">
                            {parsed.thinking}
                        </div>
                    )}
                </div>
            )}

            {/* 5. 工具调用（Tool Calls）展示 */}
            {parsed.toolCalls.length > 0 && (
                <div className="bg-purple-50/40 dark:bg-purple-950/20 rounded-xl border border-purple-200/60 dark:border-purple-900/40 p-4 space-y-2">
                    <div className="flex items-center gap-2 text-purple-700 dark:text-purple-300 font-bold text-xs mb-1">
                        <Wrench size={14} />
                        <span>{t('monitor.conversation.tool_calls', '工具/函数调用 (Tool Calls)')} ({parsed.toolCalls.length})</span>
                    </div>
                    <div className="space-y-2">
                        {parsed.toolCalls.map((tc, idx) => (
                            <div key={idx} className="bg-white dark:bg-base-200 p-2.5 rounded-lg border border-purple-100 dark:border-purple-900/40 text-xs font-mono">
                                <span className="font-bold text-purple-600 dark:text-purple-400">{tc.name}</span>
                                {tc.args && (
                                    <div className="mt-1.5 p-2 bg-gray-50 dark:bg-base-300 rounded text-[11px] text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                                        {tc.args}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 6. 模型最终回答卡片 */}
            {parsed.modelAnswer && (
                <div className="bg-emerald-50/40 dark:bg-emerald-950/20 rounded-xl border border-emerald-200/70 dark:border-emerald-900/50 overflow-hidden shadow-xs">
                    <div className="flex items-center justify-between px-4 py-2.5 bg-emerald-100/50 dark:bg-emerald-900/30 border-b border-emerald-200/50 dark:border-emerald-900/40">
                        <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300 font-bold text-xs">
                            <span className="p-1 rounded-md bg-emerald-200 dark:bg-emerald-800/60">
                                <Sparkles size={14} />
                            </span>
                            <span>{t('monitor.conversation.model_answer', '模型回答 (Response)')}</span>
                        </div>
                        <button
                            type="button"
                            onClick={() => handleCopy(parsed.modelAnswer || '', `model-${logId}`)}
                            className="btn btn-ghost btn-xs gap-1 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-200/50 dark:hover:bg-emerald-800/40"
                            title={t('proxy.config.btn_copy')}
                        >
                            {copiedKey === `model-${logId}` ? (
                                <>
                                    <CheckCircle size={12} className="text-green-500" />
                                    <span className="text-[10px] text-green-600 dark:text-green-400 font-semibold">
                                        {t('proxy.config.btn_copied', '已复制')}
                                    </span>
                                </>
                            ) : (
                                <>
                                    <Copy size={12} />
                                    <span className="text-[10px]">{t('proxy.config.btn_copy', '复制回答')}</span>
                                </>
                            )}
                        </button>
                    </div>
                    <div className="p-4 text-xs leading-relaxed text-gray-900 dark:text-gray-100 whitespace-pre-wrap font-sans select-text max-h-[500px] overflow-y-auto">
                        {parsed.modelAnswer}
                    </div>
                </div>
            )}

            {/* 7. 错误信息展示（如果有） */}
            {parsed.errorMessage && (
                <div className="bg-red-50 dark:bg-red-950/20 rounded-xl border border-red-200 dark:border-red-900/50 p-4">
                    <div className="flex items-center gap-2 text-red-700 dark:text-red-400 font-bold text-xs mb-2">
                        <AlertTriangle size={14} />
                        <span>{t('monitor.conversation.error_title', '请求异常与报错信息')}</span>
                    </div>
                    <div className="p-3 bg-white dark:bg-base-200 rounded-lg border border-red-100 dark:border-red-900/40 font-mono text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap leading-relaxed select-text">
                        {parsed.errorMessage}
                    </div>
                </div>
            )}

            {/* 8. 多模态大图点击放大弹窗 (Lightbox Modal) */}
            {previewModalImg && (
                <div
                    className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4"
                    onClick={() => setPreviewModalImg(null)}
                >
                    <div
                        className="relative max-w-3xl max-h-[85vh] bg-white dark:bg-base-100 rounded-2xl overflow-hidden shadow-2xl p-2"
                        onClick={e => e.stopPropagation()}
                    >
                        <button
                            type="button"
                            onClick={() => setPreviewModalImg(null)}
                            className="absolute top-4 right-4 btn btn-circle btn-sm btn-ghost bg-black/50 text-white hover:bg-black/70 z-10"
                        >
                            <X size={16} />
                        </button>
                        <img
                            src={previewModalImg.src}
                            alt={previewModalImg.label}
                            className="w-auto h-auto max-w-full max-h-[80vh] object-contain rounded-xl mx-auto"
                        />
                    </div>
                </div>
            )}
        </div>
    );
};
