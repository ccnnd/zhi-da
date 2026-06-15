// 再诊提示条——底部滑入动画，3 秒自动消失，提供立即诊断或暂不按钮
import { useEffect, type FC } from 'react'

interface Props {
  visible: boolean
  message: string
  onReEvaluate: () => void
  onDismiss: () => void
}

const ReEvaluatePrompt: FC<Props> = ({ visible, message, onReEvaluate, onDismiss }) => {
  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(onDismiss, 15000)
    return () => clearTimeout(timer)
  }, [visible, onDismiss])

  if (!visible) return null

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 100,
      animation: 'slideUpFull 0.4s ease-out forwards',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 24px',
        background: 'var(--bg-hover)',
        borderTop: '1px solid var(--border-light)',
        boxShadow: 'var(--shadow-lg)',
        maxWidth: 1200,
        margin: '0 auto',
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        transition: 'background-color 0.3s, border-color 0.3s',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{message}</span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onReEvaluate}
            style={{
              padding: '7px 20px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--accent-primary)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 12, fontWeight: 600,
              fontFamily: 'var(--font-display)',
              letterSpacing: '0.5px',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 0 16px rgba(var(--accent-primary-rgb), 0.4)'; e.currentTarget.style.transform = 'scale(1.03)' }}
            onMouseLeave={e => { e.currentTarget.style.boxShadow = ''; e.currentTarget.style.transform = '' }}
          >
            立即重新诊断
          </button>
          <button
            onClick={onDismiss}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              border: '1px solid var(--border-light)',
              background: 'transparent',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              fontSize: 12, fontWeight: 500,
              fontFamily: 'var(--font-display)',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-secondary)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-light)'; e.currentTarget.style.color = 'var(--text-tertiary)' }}
          >
            暂不
          </button>
        </div>
      </div>
    </div>
  )
}

export default ReEvaluatePrompt
