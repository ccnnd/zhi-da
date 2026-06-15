// 导出工具栏——底栏 JSON/Excel/PDF 三个导出按钮，hover 发光
import { useState, type FC } from 'react'
import { getAuthToken } from '../../services/api'

interface Props {
  studentId: string | number
  diagnosisId: string
  version?: number
}

const btnBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 16px',
  borderRadius: 6,
  border: '1px solid var(--border-light)',
  background: 'var(--bg-card)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'var(--font-display)',
  letterSpacing: '0.5px',
  transition: 'all 0.25s ease',
}

const ExportToolbar: FC<Props> = ({ studentId, diagnosisId, version }) => {
  const [exporting, setExporting] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const exportUrls: Record<string, string> = {
    json: `/api/export/profile/${studentId}${diagnosisId ? `?diagnosis_id=${diagnosisId}` : ''}`,
    excel: `/api/export/profile/${studentId}/excel${diagnosisId ? `?diagnosis_id=${diagnosisId}` : ''}`,
    pdf: `/api/export/path/${studentId}${diagnosisId ? `?diagnosis_id=${diagnosisId}` : ''}`,
  }

  const fileExtensions: Record<string, string> = { json: 'json', excel: 'xlsx', pdf: 'pdf' }

  const openExport = async (format: string) => {
    const url = exportUrls[format]
    if (!url) return
    setExporting(format)
    try {
      const headers: Record<string, string> = {}
      const token = getAuthToken()
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`导出失败 (${res.status})`)
      // 后端找不到诊断时返回 JSON {"error":...}，需拦截避免把错误当文件下载
      const ctype = res.headers.get('content-type') || ''
      if (ctype.includes('application/json')) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || '未找到诊断数据，无法导出')
      }
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      const verTag = version ? `v${version}_` : ''
      a.download = `职达_${verTag}${studentId}.${fileExtensions[format]}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(blobUrl)
    } catch (err: any) {
      setToast(err.message || '导出失败，请稍后重试')
      setTimeout(() => setToast(null), 3000)
    } finally {
      setExporting(null)
    }
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 24px',
      background: 'var(--bg-elevated)',
      borderTop: '1px solid var(--border-light)',
      position: 'sticky',
      bottom: 0,
      zIndex: 98,
      backdropFilter: 'blur(var(--glass-blur, 12px))',
      WebkitBackdropFilter: 'blur(var(--glass-blur, 12px))',
    }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          style={btnBase}
          onClick={() => openExport('json')}
          disabled={exporting !== null}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'var(--accent-primary)'
            e.currentTarget.style.color = 'var(--accent-primary)'
            e.currentTarget.style.boxShadow = '0 0 12px rgba(var(--accent-primary-rgb), 0.2)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'var(--border-light)'
            e.currentTarget.style.color = 'var(--text-secondary)'
            e.currentTarget.style.boxShadow = ''
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          {exporting === 'json' ? '导出中...' : '导出 JSON'}
        </button>
        <button
          style={btnBase}
          onClick={() => openExport('excel')}
          disabled={exporting !== null}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'var(--accent-success)'
            e.currentTarget.style.color = 'var(--accent-success)'
            e.currentTarget.style.boxShadow = '0 0 12px rgba(74,222,128,0.2)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'var(--border-light)'
            e.currentTarget.style.color = 'var(--text-secondary)'
            e.currentTarget.style.boxShadow = ''
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
          </svg>
          {exporting === 'excel' ? '导出中...' : '导出 Excel'}
        </button>
        <button
          style={btnBase}
          onClick={() => openExport('pdf')}
          disabled={exporting !== null}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'var(--accent-danger)'
            e.currentTarget.style.color = 'var(--accent-danger)'
            e.currentTarget.style.boxShadow = '0 0 12px rgba(244,114,182,0.2)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'var(--border-light)'
            e.currentTarget.style.color = 'var(--text-secondary)'
            e.currentTarget.style.boxShadow = ''
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          {exporting === 'pdf' ? '导出中...' : '导出 PDF'}
        </button>
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
        诊断版本 v{version ?? '--'} | {new Date().toISOString().slice(0, 10)}
      </span>
      {toast && (
        <div style={{
          position: 'fixed', bottom: 70, left: '50%', transform: 'translateX(-50%)', zIndex: 300,
          padding: '8px 20px', borderRadius: 8, background: 'var(--accent-danger)', color: '#fff',
          fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-display)',
          boxShadow: '0 4px 12px rgba(244,114,182,0.3)', animation: 'slideUp 0.2s ease-out',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

export default ExportToolbar
