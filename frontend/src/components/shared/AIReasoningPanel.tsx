// AI 依据面板——可折叠展示 AI 建议的决策依据、选择的 Skill、置信度、使用工具、局限性和 Pipeline 元数据
import { useState, type FC } from 'react'

export interface PipelineMeta {
  total_steps?: number
  total_duration_ms?: number
  error_count?: number
  fallback_count?: number
  fallback_steps?: string[]
  fallback_errors?: Record<string, string>
  pipeline_duration_ms?: number
}

export interface ReasoningData {
  goal?: string
  basis?: string[]
  decision?: string
  confidence?: number
  used_tools?: string[]
  limits?: string[]
  selected_skill?: string
  next_check?: string
  pipeline_meta?: PipelineMeta
}

interface Props {
  reasoning?: ReasoningData
  nextActions?: Array<{ label: string; intent: string; payload: Record<string, any> }>
  onNextAction?: (action: { label: string; intent: string; payload: Record<string, any> }) => void
}

// Skill 名称中文映射
const SKILL_LABELS: Record<string, string> = {
  profile_completeness_check: '档案完整度检查',
  diagnose_student: '能力诊断',
  match_jobs: '岗位匹配',
  plan_growth_tasks: '成长任务规划',
  review_task_evidence: '证据审核',
  re_evaluate_student: '复评',
  authorization_advice: '授权建议',
  answer_student_question: '问答',
}

// Pipeline 步骤中文映射
const STEP_LABELS: Record<string, string> = {
  profile: '画像分析',
  match: '岗位匹配',
  gap: '差距评估',
  path: '路径规划',
  advice: '建议生成',
}

const confidenceLabel = (c: number): { text: string; color: string; bg: string } => {
  if (c > 0.8) return { text: '高', color: 'var(--accent-success)', bg: 'rgba(var(--accent-success-rgb), 0.12)' }
  if (c > 0.5) return { text: '中', color: 'var(--accent-warning)', bg: 'rgba(var(--accent-warning-rgb), 0.12)' }
  if (c > 0.3) return { text: '低', color: 'var(--accent-danger)', bg: 'rgba(var(--accent-danger-rgb), 0.12)' }
  return { text: '极低', color: 'var(--text-tertiary)', bg: 'rgba(120,120,120,0.08)' }
}

const AIReasoningPanel: FC<Props> = ({ reasoning, nextActions, onNextAction }) => {
  const [expanded, setExpanded] = useState(false)

  if (!reasoning) return null

  const pm = reasoning.pipeline_meta
  const hasFallback = pm && (pm.fallback_count ?? 0) > 0

  const hasContent = reasoning.goal || reasoning.decision || (reasoning.basis && reasoning.basis.length > 0) || reasoning.confidence != null || (reasoning.used_tools && reasoning.used_tools.length > 0) || (reasoning.limits && reasoning.limits.length > 0) || reasoning.selected_skill || reasoning.next_check || hasFallback
  if (!hasContent) return null

  const confBadge = reasoning.confidence != null ? confidenceLabel(reasoning.confidence) : null
  const skillLabel = reasoning.selected_skill
    ? SKILL_LABELS[reasoning.selected_skill] || reasoning.selected_skill
    : ''

  return (
    <div className="ai-panel">
      {/* Fallback degradation banner */}
      {hasFallback && (
        <div className="ai-panel-fallback-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span style={{ fontSize: 11, color: 'var(--accent-warning)', fontWeight: 600 }}>
            部分步骤已降级处理
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
            ({pm.fallback_steps?.map(s => STEP_LABELS[s] || s).join('、') || `${pm.fallback_count} 个步骤`})
          </span>
        </div>
      )}

      <button
        className="ai-panel-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
          </svg>
          AI 依据
          {skillLabel && (
            <span className="ai-panel-tag ai-panel-tag-primary">
              {skillLabel}
            </span>
          )}
          {confBadge && (
            <span className="ai-panel-tag" style={{ background: confBadge.bg, color: confBadge.color }}>
              {confBadge.text}
            </span>
          )}
          {hasFallback && (
            <span className="ai-panel-tag ai-panel-tag-warning">
              降级
            </span>
          )}
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.3s ease' }}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div className={`ai-panel-body${expanded ? ' open' : ''}`}>
        <div className="ai-panel-content">
          {/* 目标 */}
          {reasoning.goal && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="ai-panel-label">目标</span>
              <span style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                {reasoning.goal}
              </span>
            </div>
          )}

          {/* 选择的 Skill */}
          {reasoning.selected_skill && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="ai-panel-label">能力</span>
              <span style={{
                fontSize: 11, padding: '2px 10px', borderRadius: 6,
                background: 'rgba(var(--accent-primary-rgb), 0.06)', color: 'var(--accent-primary)',
                border: '1px solid rgba(var(--accent-primary-rgb), 0.12)', fontWeight: 500,
              }}>
                {skillLabel}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                {reasoning.selected_skill}
              </span>
            </div>
          )}

          {reasoning.decision && (
            <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.6 }}>
              {reasoning.decision}
            </div>
          )}

          {reasoning.basis && reasoning.basis.length > 0 && (
            <div>
              <div className="ai-panel-label" style={{ marginBottom: 4 }}>依据</div>
              <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {reasoning.basis.map((b, i) => (
                  <li key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          {reasoning.used_tools && reasoning.used_tools.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className="ai-panel-label">工具</span>
              {reasoning.used_tools.map((tool, i) => (
                <span key={i} className="ai-panel-tag ai-panel-tag-primary">
                  {tool}
                </span>
              ))}
            </div>
          )}

          {reasoning.limits && reasoning.limits.length > 0 && (
            <div className="ai-panel-limits">
              <div style={{ fontSize: 11, color: 'var(--accent-warning)', marginBottom: 4, fontWeight: 600, fontFamily: 'var(--font-display)' }}>
                局限
              </div>
              {reasoning.limits.map((l, i) => (
                <div key={i} style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                  {l}
                </div>
              ))}
            </div>
          )}

          {/* 下次验证条件 */}
          {reasoning.next_check && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              <span style={{ fontFamily: 'var(--font-display)' }}>下次验证: </span>
              <span style={{ color: 'var(--text-secondary)' }}>{reasoning.next_check}</span>
            </div>
          )}

          {/* 下一步操作按钮 */}
          {nextActions && nextActions.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {nextActions.map((action, i) => (
                <button
                  key={i}
                  className="ai-panel-action"
                  onClick={() => onNextAction?.(action)}
                  disabled={!onNextAction}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}

          {/* Pipeline 运行元数据 */}
          {pm && (pm.total_steps || pm.pipeline_duration_ms) && (
            <div className="ai-panel-meta">
              <div className="ai-panel-label" style={{ marginBottom: 4 }}>
                运行流程详情
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary)' }}>
                {(pm.total_steps ?? 0) > 0 && <span>步骤: {pm.total_steps}</span>}
                {(pm.pipeline_duration_ms ?? 0) > 0 && <span>总耗时: {(pm.pipeline_duration_ms ?? 0).toFixed(0)}毫秒</span>}
                {(pm.error_count ?? 0) > 0 && <span style={{ color: 'var(--accent-danger)' }}>错误: {pm.error_count}</span>}
              </div>
              {pm.fallback_errors && Object.keys(pm.fallback_errors).length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {Object.entries(pm.fallback_errors).map(([step, err]) => (
                    <div key={step} style={{ fontSize: 10, color: 'var(--accent-warning)', lineHeight: 1.5 }}>
                      {STEP_LABELS[step] || step}: {String(err).slice(0, 100)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default AIReasoningPanel
