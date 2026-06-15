// Agent Trace Timeline -- vertical timeline visualization for Agent decision flow
import { type FC } from 'react'

export interface TraceRecord {
  request_id: string
  intent: string
  selected_skill: string
  used_tools: string[]
  rejected_tools?: Array<{ name: string; reason: string }>
  confidence: number
  duration_ms: number
  fallback_used: number
  input_summary: string
  output_action: string
  created_at: string
}

interface Props {
  traces: TraceRecord[]
}

// Skill display name mapping (mirrors AIReasoningPanel SKILL_LABELS)
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

// Intent type color mapping
const INTENT_COLORS: Record<string, { bg: string; text: string }> = {
  diagnose: { bg: 'rgba(var(--accent-primary-rgb), 0.12)', text: 'var(--accent-primary)' },
  match: { bg: 'rgba(var(--accent-success-rgb), 0.12)', text: 'var(--accent-success)' },
  plan: { bg: 'rgba(175,82,222,0.12)', text: '#af52de' },
  review: { bg: 'rgba(var(--accent-warning-rgb), 0.12)', text: '#ff9500' },
  authorize: { bg: 'rgba(0,199,190,0.12)', text: '#00c7be' },
  question: { bg: 'rgba(99,99,99,0.10)', text: 'var(--text-secondary)' },
  re_evaluate: { bg: 'rgba(var(--accent-danger-rgb), 0.10)', text: 'var(--accent-danger)' },
  profile_check: { bg: 'rgba(88,86,214,0.12)', text: '#5856d6' },
}

const FALLBACK_COLOR = '#ff9500'
const RAIL_COLOR = 'var(--border-light)'
const RAIL_FALLBACK_COLOR = 'rgba(var(--accent-warning-rgb), 0.5)'

function getIntentColor(intent: string) {
  if (!intent) return { bg: 'rgba(99,99,99,0.10)', text: 'var(--text-secondary)' }
  const lower = intent.toLowerCase()
  for (const [key, val] of Object.entries(INTENT_COLORS)) {
    if (lower.includes(key)) return val
  }
  return { bg: 'rgba(99,99,99,0.10)', text: 'var(--text-secondary)' }
}

function getConfidenceInfo(c: number) {
  if (c > 0.8) return { label: '高', color: 'var(--accent-success)', bg: 'rgba(var(--accent-success-rgb), 0.12)' }
  if (c > 0.5) return { label: '中', color: '#ff9500', bg: 'rgba(var(--accent-warning-rgb), 0.12)' }
  if (c > 0.3) return { label: '低', color: '#ef4444', bg: 'rgba(var(--accent-danger-rgb), 0.12)' }
  return { label: '极低', color: 'var(--text-tertiary)', bg: 'rgba(120,120,120,0.08)' }
}

function formatTimestamp(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    const secs = String(d.getSeconds()).padStart(2, '0')
    return `${month}-${day} ${hours}:${mins}:${secs}`
  } catch {
    return iso
  }
}

function truncate(text: string, max: number): string {
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '...' : text
}

const TraceTimeline: FC<Props> = ({ traces }) => {
  if (!traces || traces.length === 0) {
    return (
      <div style={{
        padding: 24,
        border: '1px dashed var(--border-light)',
        borderRadius: 12,
        textAlign: 'center',
        fontSize: 12,
        color: 'var(--text-tertiary)',
      }}>
        暂无 Agent 追踪记录
      </div>
    )
  }

  // Most recent first
  const sorted = [...traces].sort((a, b) => {
    const ta = new Date(a.created_at).getTime() || 0
    const tb = new Date(b.created_at).getTime() || 0
    return tb - ta
  })

  return (
    <div style={{ position: 'relative', padding: '4px 0 4px 0' }}>
      {sorted.map((trace, idx) => {
        const isFallback = !!trace.fallback_used
        const confInfo = getConfidenceInfo(trace.confidence)
        const intentColor = getIntentColor(trace.intent)
        const skillLabel = SKILL_LABELS[trace.selected_skill] || trace.selected_skill || '--'
        const railColor = isFallback ? RAIL_FALLBACK_COLOR : RAIL_COLOR
        const isLast = idx === sorted.length - 1

        return (
          <div
            key={trace.request_id || idx}
            style={{
              display: 'flex',
              gap: 0,
              position: 'relative',
            }}
          >
            {/* Left rail: vertical line + node circle */}
            <div style={{
              width: 36,
              minWidth: 36,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              position: 'relative',
            }}>
              {/* Top connector line */}
              {idx > 0 && (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 2,
                  height: 20,
                  background: railColor,
                }} />
              )}
              {/* Node circle */}
              <div style={{
                marginTop: idx > 0 ? 20 : 8,
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: `2.5px solid ${isFallback ? FALLBACK_COLOR : confInfo.color}`,
                background: 'var(--bg-card)',
                position: 'relative',
                zIndex: 2,
                flexShrink: 0,
              }} />
              {/* Bottom connector line */}
              {!isLast && (
                <div style={{
                  flex: 1,
                  width: 2,
                  background: railColor,
                  minHeight: 12,
                }} />
              )}
            </div>

            {/* Content card */}
            <div style={{
              flex: 1,
              margin: idx > 0 ? '0 0 4px 0' : '0 0 4px 0',
              padding: '12px 16px',
              borderRadius: 10,
              border: `1px solid ${isFallback ? 'rgba(var(--accent-warning-rgb), 0.25)' : 'var(--border-light)'}`,
              background: isFallback ? 'rgba(var(--accent-warning-rgb), 0.03)' : 'var(--bg-card)',
              minWidth: 0,
            }}>
              {/* Row 1: Intent badge + timestamp */}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    display: 'inline-block',
                    padding: '2px 10px',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    background: intentColor.bg,
                    color: intentColor.text,
                    lineHeight: '20px',
                  }}>
                    {trace.intent || 'unknown'}
                  </span>
                  {isFallback && (
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: 6,
                      fontSize: 10,
                      fontWeight: 600,
                      background: 'rgba(var(--accent-warning-rgb), 0.12)',
                      color: FALLBACK_COLOR,
                      lineHeight: '18px',
                    }}>
                      Fallback
                    </span>
                  )}
                </div>
                <span style={{
                  fontSize: 10,
                  color: 'var(--text-tertiary)',
                  whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-mono, monospace)',
                }}>
                  {formatTimestamp(trace.created_at)}
                </span>
              </div>

              {/* Row 2: Skill + Confidence + Duration */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                fontSize: 12,
                marginBottom: 8,
              }}>
                <span style={{
                  padding: '2px 8px',
                  borderRadius: 5,
                  background: 'rgba(var(--accent-primary-rgb), 0.08)',
                  color: 'var(--accent-primary)',
                  fontSize: 11,
                  fontWeight: 600,
                }}>
                  {skillLabel}
                </span>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                }}>
                  <span style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: confInfo.color,
                    display: 'inline-block',
                  }} />
                  <span style={{
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: confInfo.bg,
                    color: confInfo.color,
                    fontWeight: 600,
                    fontSize: 10,
                  }}>
                    {confInfo.label} {(trace.confidence * 100).toFixed(0)}%
                  </span>
                </span>
                <span style={{
                  fontSize: 11,
                  color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-mono, monospace)',
                }}>
                  {trace.duration_ms}ms
                </span>
              </div>

              {/* Row 3: Used tools as pills */}
              {trace.used_tools && trace.used_tools.length > 0 && (
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 4,
                  marginBottom: 6,
                }}>
                  {trace.used_tools.map((tool, ti) => (
                    <span
                      key={ti}
                      style={{
                        display: 'inline-block',
                        padding: '1px 7px',
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 500,
                        background: 'var(--bg-hover)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-light)',
                        lineHeight: '18px',
                      }}
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              )}

              {/* Row 4: Rejected tools (if any) */}
              {trace.rejected_tools && trace.rejected_tools.length > 0 && (
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 4,
                  marginBottom: 6,
                  alignItems: 'center',
                }}>
                  <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>未选用:</span>
                  {trace.rejected_tools.map((rt, ri) => (
                    <span
                      key={ri}
                      style={{
                        display: 'inline-block',
                        padding: '1px 7px',
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 500,
                        background: 'rgba(var(--accent-danger-rgb), 0.06)',
                        color: 'var(--text-tertiary)',
                        border: '1px dashed var(--border-light)',
                        lineHeight: '18px',
                        textDecoration: 'line-through',
                      }}
                      title={rt.reason}
                    >
                      {rt.name}
                    </span>
                  ))}
                </div>
              )}

              {/* Row 5: Input summary */}
              {trace.input_summary && (
                <div style={{
                  fontSize: 11,
                  color: 'var(--text-tertiary)',
                  lineHeight: 1.5,
                  marginTop: 2,
                }}>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>输入: </span>
                  {truncate(trace.input_summary, 80)}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default TraceTimeline
