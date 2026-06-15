// 多轮对话面板——右侧抽屉式聊天界面，支持 SSE 流式问答
import { useState, useEffect, useRef, useCallback, type FC } from 'react'
import { getConversationMessages, runStudentAgentStream } from '../../services/api'
import type { ConversationMessage } from '../../types'

interface Props {
  studentId: string | number
  open: boolean
  onClose: () => void
}

// 格式化时间戳
const formatTime = (iso?: string): string => {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    if (isToday) return time
    return `${d.getMonth() + 1}/${d.getDate()} ${time}`
  } catch {
    return ''
  }
}

// 将后端 role "system" 映射为前端 "system_summary"
const mapRole = (role: string): ConversationMessage['role'] => {
  if (role === 'system' || role === 'system_summary') return 'system_summary'
  if (role === 'assistant') return 'assistant'
  return 'user'
}

const ConversationPanel: FC<Props> = ({ studentId, open, onClose }) => {
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [streamStatus, setStreamStatus] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 自动滚动到底部
  const scrollToBottom = useCallback(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [])

  // 打开时加载历史消息
  useEffect(() => {
    if (!open || !studentId) return
    setFetching(true)
    getConversationMessages(studentId, 20)
      .then((data) => {
        const mapped: ConversationMessage[] = (data.messages || []).map((m: any) => ({
          role: mapRole(m.role),
          content: m.content || '',
          intent: m.intent,
          created_at: m.created_at,
        }))
        setMessages(mapped)
      })
      .catch((err) => {
        console.warn('加载对话历史失败:', err)
      })
      .finally(() => {
        setFetching(false)
        setTimeout(scrollToBottom, 100)
      })
  }, [open, studentId, scrollToBottom])

  // 消息变化时滚动到底部
  useEffect(() => {
    scrollToBottom()
  }, [messages, streamStatus, scrollToBottom])

  // 发送消息
  const handleSend = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || loading || !studentId) return

    // 添加用户消息
    const userMsg: ConversationMessage = {
      role: 'user',
      content: trimmed,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)
    setStreamStatus('thinking')

    try {
      const result = await runStudentAgentStream(
        studentId,
        'ask',
        { message: trimmed },
        (stage, _progress, _message) => {
          if (stage === 'thinking') setStreamStatus('thinking')
          else if (stage === 'reasoning') setStreamStatus('reasoning')
          else if (stage === 'composing') setStreamStatus('composing')
          else setStreamStatus(stage)
        },
      )

      // 用最终回复替换占位消息
      const aiMsg: ConversationMessage = {
        role: 'assistant',
        content: result.message || '',
        intent: 'ask',
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, aiMsg])
    } catch (err: any) {
      const errorMsg: ConversationMessage = {
        role: 'assistant',
        content: `抱歉，出现了问题：${err?.message || '请稍后重试'}`,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, errorMsg])
    } finally {
      setLoading(false)
      setStreamStatus('')
    }
  }, [input, loading, studentId])

  // 回车发送（Shift+Enter 换行）
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  // 流式状态文本
  const statusText = (() => {
    switch (streamStatus) {
      case 'thinking':
        return 'AI 正在思考...'
      case 'reasoning':
        return 'AI 正在推理分析...'
      case 'composing':
        return 'AI 正在组织回答...'
      default:
        return streamStatus ? `${streamStatus}...` : ''
    }
  })()

  return (
    <>
      {/* Backdrop overlay */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.35)',
          zIndex: 998,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.3s ease',
        }}
      />

      {/* Drawer panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 380,
          maxWidth: '100vw',
          background: 'var(--bg-card, #fff)',
          borderLeft: '1px solid var(--border-default, #e0e0e0)',
          zIndex: 999,
          display: 'flex',
          flexDirection: 'column',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: open ? '-4px 0 24px rgba(0,0,0,0.08)' : 'none',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
            borderBottom: '1px solid var(--border-default, #e0e0e0)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent-primary, var(--accent-primary))"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: 'var(--text-primary, #1d1d1f)',
                fontFamily: 'var(--font-display, system-ui)',
              }}
            >
              AI 助手对话
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              border: 'none',
              background: 'var(--bg-hover, rgba(0,0,0,0.05))',
              borderRadius: 6,
              cursor: 'pointer',
              color: 'var(--text-secondary, #6e6e73)',
              transition: 'background 0.2s',
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Message list */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {/* Fetching spinner */}
          {fetching && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  border: '3px solid var(--border-default, #e0e0e0)',
                  borderTopColor: 'var(--accent-primary, var(--accent-primary))',
                  borderRadius: '50%',
                  animation: 'conv-spin 0.8s linear infinite',
                }}
              />
            </div>
          )}

          {/* Empty state */}
          {!fetching && messages.length === 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 1,
                padding: '40px 20px',
                textAlign: 'center',
              }}
            >
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--text-tertiary, #aeaeb2)"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ marginBottom: 16, opacity: 0.6 }}
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <div
                style={{
                  fontSize: 14,
                  color: 'var(--text-secondary, #6e6e73)',
                  lineHeight: 1.6,
                }}
              >
                向 AI 助手提问任何职业成长问题
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-tertiary, #aeaeb2)',
                  marginTop: 8,
                }}
              >
                例如：我的技能差距在哪里？推荐哪些学习资源？
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, idx) => {
            if (msg.role === 'system_summary') {
              // System summary: centered, small italic
              return (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    padding: '4px 8px',
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      fontStyle: 'italic',
                      color: 'var(--text-tertiary, #aeaeb2)',
                      textAlign: 'center',
                      maxWidth: '90%',
                      lineHeight: 1.5,
                      padding: '6px 10px',
                      background: 'var(--bg-hover, rgba(0,0,0,0.03))',
                      borderRadius: 8,
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>[系统摘要]</span>{' '}
                    {msg.content.replace(/^\[系统记忆摘要[^\]]*\]\n?/, '')}
                  </div>
                </div>
              )
            }

            const isUser = msg.role === 'user'
            return (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  justifyContent: isUser ? 'flex-end' : 'flex-start',
                  padding: '0 4px',
                }}
              >
                <div
                  style={{
                    maxWidth: '85%',
                    padding: isUser ? '10px 14px' : '12px 14px',
                    borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                    background: isUser
                      ? 'var(--accent-primary, var(--accent-primary))'
                      : 'var(--bg-hover, rgba(0,0,0,0.04))',
                    color: isUser
                      ? '#fff'
                      : 'var(--text-primary, #1d1d1f)',
                    fontSize: 13,
                    lineHeight: 1.6,
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  <div>{msg.content}</div>
                  {msg.created_at && (
                    <div
                      style={{
                        fontSize: 10,
                        marginTop: 4,
                        opacity: isUser ? 0.7 : 0.5,
                        textAlign: isUser ? 'right' : 'left',
                      }}
                    >
                      {formatTime(msg.created_at)}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* Streaming status */}
          {loading && streamStatus && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 12px',
                fontSize: 12,
                color: 'var(--text-tertiary, #aeaeb2)',
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  border: '2px solid var(--border-default, #e0e0e0)',
                  borderTopColor: 'var(--accent-primary, var(--accent-primary))',
                  borderRadius: '50%',
                  animation: 'conv-spin 0.8s linear infinite',
                }}
              />
              {statusText}
            </div>
          )}
        </div>

        {/* Input area */}
        <div
          style={{
            flexShrink: 0,
            padding: '12px 12px 14px',
            borderTop: '1px solid var(--border-default, #e0e0e0)',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入你的问题..."
            rows={1}
            disabled={loading}
            style={{
              flex: 1,
              resize: 'none',
              border: '1px solid var(--border-default, #e0e0e0)',
              borderRadius: 10,
              padding: '10px 12px',
              fontSize: 13,
              lineHeight: 1.5,
              fontFamily: 'inherit',
              color: 'var(--text-primary, #1d1d1f)',
              background: 'var(--bg-card, #fff)',
              outline: 'none',
              minHeight: 40,
              maxHeight: 100,
              transition: 'border-color 0.2s',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent-primary, var(--accent-primary))'
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-default, #e0e0e0)'
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 38,
              height: 38,
              border: 'none',
              borderRadius: 10,
              background:
                !input.trim() || loading
                  ? 'var(--bg-hover, rgba(0,0,0,0.05))'
                  : 'var(--accent-primary, var(--accent-primary))',
              color:
                !input.trim() || loading
                  ? 'var(--text-tertiary, #aeaeb2)'
                  : '#fff',
              cursor: !input.trim() || loading ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
              flexShrink: 0,
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>

        {/* Spinner keyframes */}
        <style>{`
          @keyframes conv-spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    </>
  )
}

export default ConversationPanel
