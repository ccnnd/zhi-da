// 成长路径 Tab——通过 Agent API 驱动任务加载、审核和复评
import { useState, useEffect, useMemo, type FC } from 'react'
import type { GrowthPhase, PhaseTask } from '../../types'
import { getGrowthTasks, submitTaskEvidence, runStudentAgent, runStudentAgentStream } from '../../services/api'
import PathTimeline from '../shared/PathTimeline'
import TaskCard from '../shared/TaskCard'
import EmptyState from '../shared/EmptyState'

// GrowthTask API 返回的任务结构
interface GrowthTaskItem {
  id: string
  diagnosis_id: string
  phase_index: number
  task_index: number
  task_name: string
  task_description: string
  linked_gap: string
  target_dimension: string
  expected_impact: Record<string, number>
  evidence_required: string
  resources: string[]
  criteria: string
  status: string
  submitted_evidence: string | null
  reviewed_by_ai: Record<string, any>
  re_evaluation_id: string | null
  completed_at: string | null
  created_at: string | null
}

// 审核结果
interface ReviewResult {
  task_id: string
  task_name: string
  evidence_length: number
  review_score: number
  has_evidence: boolean
  preliminary_approved: boolean
  feedback: string
}

interface Props {
  growthPath: { phases: GrowthPhase[] }
  diagnosisId: string
  studentId: string | number
  onTaskComplete: (taskId: string) => void
  /** 复评完成后的回调，用于刷新诊断数据 */
  onReEvaluateComplete?: (newDiagnosisId: string) => void
}

const PathTab: FC<Props> = ({ growthPath, diagnosisId, studentId, onTaskComplete, onReEvaluateComplete }) => {
  const [activePhase, setActivePhase] = useState(0)
  const [completing, setCompleting] = useState<string | null>(null)
  const [completedTasks, setCompletedTasks] = useState<Set<string>>(new Set())
  const [taskError, setTaskError] = useState<string | null>(null)

  // 审核结果
  const [reviewResult, setReviewResult] = useState<ReviewResult | null>(null)
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null)

  // 复评状态
  const [reEvalConfirm, setReEvalConfirm] = useState<{ taskId: string; taskName: string } | null>(null)
  const [reEvalRunning, setReEvalRunning] = useState(false)
  const [reEvalStage, setReEvalStage] = useState('')
  const [reEvalProgress, setReEvalProgress] = useState(0)

  // 新版 GrowthTask 数据
  const [growthTaskItems, setGrowthTaskItems] = useState<GrowthTaskItem[]>([])
  const [useGrowthTaskApi, setUseGrowthTaskApi] = useState(false)
  const [loadingTasks, setLoadingTasks] = useState(true)
  const [loadError, setLoadError] = useState(false)

  // 加载成长任务：优先 Agent API，降级 GrowthTask API，再降级 growth_path JSON
  const loadTasks = () => {
    if (!studentId) return
    setLoadingTasks(true)
    setLoadError(false)
    // 优先通过 Agent API 加载
    runStudentAgent(studentId, 'continue_growth')
      .then((result) => {
        const items = result.data?.tasks
        if (Array.isArray(items) && items.length > 0) {
          setGrowthTaskItems(items)
          setUseGrowthTaskApi(true)
          const done = new Set<string>(
            items.filter((t: any) => t.status === 'completed').map((t: any) => t.task_name)
          )
          setCompletedTasks(done)
        } else {
          // Agent 返回空，降级到直接 API
          return getGrowthTasks(studentId, diagnosisId).then((directItems: any[]) => {
            if (Array.isArray(directItems) && directItems.length > 0) {
              setGrowthTaskItems(directItems)
              setUseGrowthTaskApi(true)
              const done = new Set<string>(
                directItems.filter((t: any) => t.status === 'completed').map((t: any) => t.task_name)
              )
              setCompletedTasks(done)
            } else {
              setUseGrowthTaskApi(false)
            }
          })
        }
      })
      .catch(() => {
        // Agent API 失败，降级到直接 API
        return getGrowthTasks(studentId, diagnosisId).then((directItems: any[]) => {
          if (Array.isArray(directItems) && directItems.length > 0) {
            setGrowthTaskItems(directItems)
            setUseGrowthTaskApi(true)
            const done = new Set<string>(
              directItems.filter((t: any) => t.status === 'completed').map((t: any) => t.task_name)
            )
            setCompletedTasks(done)
          } else {
            setUseGrowthTaskApi(false)
          }
        }).catch(() => {
          // 两个 API 都失败：标记错误而非静默降级到空 JSON
          setUseGrowthTaskApi(false)
          setLoadError(true)
        })
      })
      .finally(() => {
        setLoadingTasks(false)
      })
  }

  useEffect(() => {
    loadTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, diagnosisId])

  // 构造 phases 数据
  const phases: GrowthPhase[] = useMemo(() => {
    if (useGrowthTaskApi && growthTaskItems.length > 0) {
      const phaseMap = new Map<number, GrowthTaskItem[]>()
      growthTaskItems.forEach(t => {
        if (!phaseMap.has(t.phase_index)) phaseMap.set(t.phase_index, [])
        phaseMap.get(t.phase_index)!.push(t)
      })
      const sortedKeys = Array.from(phaseMap.keys()).sort((a, b) => a - b)
      const gpPhases = growthPath?.phases ?? []
      return sortedKeys.map((phaseIdx) => {
        const items = phaseMap.get(phaseIdx)!.sort((a, b) => a.task_index - b.task_index)
        const gpPhase = gpPhases[phaseIdx]
        return {
          goal: gpPhase?.goal ?? `阶段 ${phaseIdx + 1}`,
          weeks: gpPhase?.weeks ?? 4,
          tasks: items.map(t => ({
            name: t.task_name,
            description: t.task_description,
            resources: t.resources || [],
            criteria: t.criteria || t.evidence_required,
            linked_gap: t.linked_gap,
            target_dimension: t.target_dimension,
            expected_impact: t.expected_impact,
          })),
        }
      })
    }
    return growthPath?.phases ?? []
  }, [useGrowthTaskApi, growthTaskItems, growthPath])

  const taskNameToId = useMemo(() => {
    const map = new Map<string, string>()
    growthTaskItems.forEach(t => map.set(t.task_name, t.id))
    return map
  }, [growthTaskItems])

  const taskNameToStatus = useMemo(() => {
    const map = new Map<string, string>()
    growthTaskItems.forEach(t => map.set(t.task_name, t.status))
    return map
  }, [growthTaskItems])

  // ===== 提交证据 + 自动审核（优先 Agent API，降级直接 API）=====
  const handleComplete = async (taskName: string, evidence: string = '') => {
    setCompleting(taskName)
    setTaskError(null)
    setReviewResult(null)
    setReviewTaskId(null)
    setReEvalConfirm(null)
    try {
      if (useGrowthTaskApi) {
        const taskId = taskNameToId.get(taskName)
        if (!taskId) throw new Error('找不到对应的任务 ID')

        // 优先通过 Agent API 审核
        let review: ReviewResult
        let status: string
        try {
          const agentResult = await runStudentAgent(studentId, 'review_task', {
            task_id: taskId,
            evidence,
          })
          review = agentResult.data?.review as ReviewResult
          status = agentResult.data?.status || (review?.preliminary_approved ? 'completed' : 'in_progress')
        } catch {
          // Agent API 失败，降级到直接 API
          const res = await submitTaskEvidence(taskId, studentId, evidence)
          review = res.review
          status = res.status
        }

        // 展示审核结果
        setReviewResult(review)
        setReviewTaskId(taskId)

        // 关键修复：无论通过与否，都同步更新本地任务状态，
        // 让卡片视觉与后端一致（通过→completed，未通过→in_progress 可重新提交）
        setGrowthTaskItems(prev => prev.map(t =>
          t.id === taskId ? { ...t, status, submitted_evidence: evidence || t.submitted_evidence } : t
        ))

        if (review.preliminary_approved) {
          setCompletedTasks(prev => new Set([...prev, taskName]))
          onTaskComplete(taskName)
          // 弹出复评确认
          setReEvalConfirm({ taskId, taskName })
        }
        // 如果未通过，状态已是 in_progress，用户可在该任务卡片重新提交证据
      } else {
        // Legacy: 旧流程不再支持，提示用户先完成诊断
        setTaskError('请先完成诊断以启用成长任务追踪。')
        setTimeout(() => setTaskError(null), 4000)
      }
    } catch (err: any) {
      const msg = err?.response?.data?.detail || err?.response?.data?.error || err?.message || '操作失败，请重试'
      setTaskError(msg)
      setTimeout(() => setTaskError(null), 4000)
    } finally {
      setCompleting(null)
    }
  }

  // ===== 触发复评（优先 Agent Stream API，降级旧 SSE）=====
  const handleReEvaluate = async (taskId: string, taskName: string) => {
    setReEvalConfirm(null)
    setReEvalRunning(true)
    setReEvalStage('准备中')
    setReEvalProgress(0)

    try {
      // 优先通过 Agent Stream API 执行复评
      const agentResult = await runStudentAgentStream(
        studentId, 're_evaluate', { task_id: taskId },
        (stage, pct, msg) => {
          setReEvalStage(stage)
          setReEvalProgress(pct)
        },
      )

      // Agent Stream 返回的 result.data 包含诊断结果
      const newDiagId = agentResult.data?.id
      if (newDiagId) {
        // 更新本地状态（Agent Runtime 已在后端关联了 re_evaluation_id）
        setGrowthTaskItems(prev =>
          prev.map(t => t.id === taskId ? { ...t, re_evaluation_id: newDiagId } : t)
        )
        // 通知父组件刷新诊断数据
        onReEvaluateComplete?.(newDiagId)
      }
    } catch (err: any) {
      const msg = err?.message || '复评失败，请稍后重试'
      setTaskError(msg)
      setTimeout(() => setTaskError(null), 4000)
    } finally {
      setReEvalRunning(false)
      setReEvalStage('')
      setReEvalProgress(0)
    }
  }

  const getTaskStatus = (task: PhaseTask, index: number): 'pending' | 'completed' | 'in_progress' => {
    const taskName = task.name
    if (completedTasks.has(taskName)) return 'completed'
    if (useGrowthTaskApi) {
      const status = taskNameToStatus.get(taskName)
      if (status === 'completed') return 'completed'
      if (status === 'in_progress') return 'in_progress'
      return 'pending'
    }
    return index === 0 ? 'in_progress' : 'pending'
  }

  if (loadingTasks) {
    return (
      <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)', fontSize: 14 }}>
        加载成长任务中...
      </div>
    )
  }

  // 加载失败：显示错误 + 重试，而非静默降级到空状态
  if (loadError) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <EmptyState icon="⚠️" title="成长任务加载失败" description="网络异常或服务暂时不可用，请重试" />
        <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={loadTasks}>重新加载</button>
      </div>
    )
  }

  if (phases.length === 0) {
    return (
      <EmptyState
        icon="📋"
        title="暂无成长任务"
        description="完成诊断后系统会为你生成个性化成长任务"
      />
    )
  }

  const currentPhaseData = phases[activePhase]
  if (!currentPhaseData) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PathTimeline phases={phases} currentPhase={activePhase} />

      {useGrowthTaskApi && (
        <div style={{
          padding: '10px 14px', borderRadius: 8,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-light)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-display)', fontWeight: 500 }}>
              成长进度
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              {growthTaskItems.filter(t => t.status === 'completed').length}/{growthTaskItems.length} 已完成
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--border-light)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 2,
              background: growthTaskItems.filter(t => t.status === 'completed').length === growthTaskItems.length && growthTaskItems.length > 0
                ? 'var(--accent-success)'
                : 'var(--accent-primary)',
              width: `${growthTaskItems.length > 0 ? (growthTaskItems.filter(t => t.status === 'completed').length / growthTaskItems.length) * 100 : 0}%`,
              transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
            }} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16 }}>
        {/* 阶段导航 */}
        <div style={{
          width: 140, flexShrink: 0,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {phases.map((phase, i) => (
            <button
              key={i}
              onClick={() => setActivePhase(i)}
              style={{
                textAlign: 'left', padding: '10px 12px', borderRadius: 6,
                border: '1px solid var(--border-light)',
                background: i === activePhase ? 'var(--bg-hover)' : 'transparent',
                color: i === activePhase ? 'var(--text-primary)' : 'var(--text-tertiary)',
                cursor: 'pointer', fontSize: 12,
                fontWeight: i === activePhase ? 600 : 400,
                fontFamily: 'var(--font-display)',
                borderLeft: i === activePhase ? '3px solid var(--accent-primary)' : '3px solid transparent',
                transition: 'all 0.2s ease',
              }}
            >
              <div style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: 10, marginBottom: 2 }}>
                阶段 {i + 1}
              </div>
              <div>{phase.goal}</div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                {phase.weeks}周 · {phase.tasks.length}个任务
              </div>
            </button>
          ))}
        </div>
        {/* 任务卡片列表 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(currentPhaseData.tasks || []).map((task, ti) => {
            const taskId = task.name
            const status = getTaskStatus(task, ti)
            const isLoading = completing === taskId
            return (
              <TaskCard
                key={ti}
                task={task}
                status={status}
                onComplete={(evidence) => handleComplete(taskId, evidence)}
                loading={isLoading}
              />
            )
          })}
        </div>
      </div>

      {/* ===== 审核结果面板 ===== */}
      {reviewResult && (
        <div style={{
          padding: 16, borderRadius: 10,
          border: `1px solid ${reviewResult.preliminary_approved ? 'rgba(var(--accent-success-rgb), 0.4)' : 'rgba(var(--accent-danger-rgb), 0.3)'}`,
          background: reviewResult.preliminary_approved ? 'rgba(var(--accent-success-rgb), 0.06)' : 'rgba(var(--accent-danger-rgb), 0.04)',
          animation: 'slideUp 0.25s ease-out',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{
              width: 24, height: 24, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700,
              background: reviewResult.preliminary_approved ? 'var(--accent-success)' : '#dc2626',
              color: '#fff',
            }}>
              {reviewResult.preliminary_approved ? '✓' : '!'}
            </span>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-display)' }}>
              AI 审核结果：{reviewResult.preliminary_approved ? '通过' : '未通过'}
            </span>
            <span style={{
              marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--font-mono)',
              color: 'var(--text-tertiary)',
            }}>
              评分 {reviewResult.review_score}/5 · {reviewResult.evidence_length} 字
            </span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {reviewResult.feedback}
          </div>
        </div>
      )}

      {/* ===== 复评确认面板 ===== */}
      {reEvalConfirm && !reEvalRunning && (
        <div style={{
          padding: 16, borderRadius: 10,
          border: '1px solid rgba(var(--accent-primary-rgb), 0.3)',
          background: 'rgba(var(--accent-primary-rgb), 0.06)',
          animation: 'slideUp 0.25s ease-out',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8, fontFamily: 'var(--font-display)' }}>
            任务「{reEvalConfirm.taskName}」审核已通过，是否触发复评？
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
            复评将重新评估你的能力画像，生成新版本诊断，以便量化本次学习带来的提升。
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => handleReEvaluate(reEvalConfirm.taskId, reEvalConfirm.taskName)}
              style={{
                padding: '8px 20px', borderRadius: 6,
                border: '1px solid var(--accent-primary)',
                background: 'rgba(var(--accent-primary-rgb), 0.12)',
                color: 'var(--accent-primary)', cursor: 'pointer',
                fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-display)',
                transition: 'all 0.2s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(var(--accent-primary-rgb), 0.22)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(var(--accent-primary-rgb), 0.12)' }}
            >
              触发复评
            </button>
            <button
              onClick={() => setReEvalConfirm(null)}
              style={{
                padding: '8px 20px', borderRadius: 6,
                border: '1px solid var(--border-light)',
                background: 'transparent', color: 'var(--text-tertiary)',
                cursor: 'pointer', fontSize: 13, fontFamily: 'var(--font-display)',
                transition: 'all 0.2s',
              }}
            >
              稍后再说
            </button>
          </div>
        </div>
      )}

      {/* ===== 复评进行中 ===== */}
      {reEvalRunning && (
        <div style={{
          padding: 16, borderRadius: 10,
          border: '1px solid rgba(var(--accent-primary-rgb), 0.25)',
          background: 'rgba(var(--accent-primary-rgb), 0.04)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{
              width: 20, height: 20, borderRadius: '50%',
              border: '2px solid var(--accent-primary)',
              borderTopColor: 'transparent',
              animation: 'spin 0.8s linear infinite',
            }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-display)' }}>
              复评进行中...
            </span>
          </div>
          <div style={{
            height: 4, borderRadius: 2, background: 'var(--border-light)', overflow: 'hidden', marginBottom: 8,
          }}>
            <div style={{
              height: '100%', borderRadius: 2,
              background: 'var(--accent-primary)',
              width: `${Math.max(5, reEvalProgress * 100)}%`,
              transition: 'width 0.3s ease',
            }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            {reEvalStage} · {Math.round(reEvalProgress * 100)}%
          </div>
        </div>
      )}

      {/* ===== 错误提示 ===== */}
      {taskError && (
        <div style={{
          padding: '10px 14px', borderRadius: 'var(--radius-sm)',
          background: '#fef2f2', border: '1px solid #fecaca',
          color: '#dc2626', fontSize: 13, marginTop: 4,
          animation: 'slideUp 0.2s ease-out',
        }}>
          {taskError}
        </div>
      )}
    </div>
  )
}

export default PathTab
