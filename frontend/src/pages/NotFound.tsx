// 404 兜底页面——未匹配路由时展示友好提示并引导回首页
import { useNavigate } from 'react-router-dom'

export default function NotFound() {
  const navigate = useNavigate()

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-page)',
      transition: 'background-color 0.3s',
    }}>
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{ fontSize: 72, fontWeight: 800, color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', lineHeight: 1 }}>
          404
        </div>
        <div style={{
          marginTop: 16, fontSize: 18, fontWeight: 600,
          color: 'var(--text-primary)', fontFamily: 'var(--font-display)',
        }}>
          页面未找到
        </div>
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          你访问的页面不存在或已被移除。请返回首页选择对应的入口。
        </div>
        <button
          onClick={() => navigate('/')}
          style={{
            marginTop: 24,
            padding: '10px 32px', borderRadius: 8, border: 'none',
            background: 'var(--accent-primary)', color: '#fff',
            cursor: 'pointer', fontSize: 14, fontWeight: 600,
            fontFamily: 'var(--font-display)', letterSpacing: '0.5px',
            transition: 'all 0.25s ease',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.boxShadow = '0 0 20px rgba(var(--accent-primary-rgb), 0.4)'
            e.currentTarget.style.transform = 'scale(1.03)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.boxShadow = ''
            e.currentTarget.style.transform = ''
          }}
        >
          返回首页
        </button>
      </div>
    </div>
  )
}
