// 一站式诊断看板——SSE 流式诊断 + 7 个 Tab 结果展示 + Bento 玻璃拟态布局 + 导出工具
import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { getDiagnosisHistory, getStudent, runStudentAgentStream, getGrowthTasks } from '../services/api'
import type { DiagnosisResult, AbilityProfile, AbilityDimension, NextAction } from '../types'
import ProgressSteps from '../components/shared/ProgressSteps'
import ReEvaluatePrompt from '../components/shared/ReEvaluatePrompt'
import ExportToolbar from '../components/export/ExportToolbar'
import OverviewTab from './Dashboard/OverviewTab'
import DiagnosisTab from './Dashboard/DiagnosisTab'
import TasksTab from './Dashboard/TasksTab'
import AuthorizationPageTab from './Dashboard/AuthorizationPageTab'
import EmptyState from '../components/shared/EmptyState'
import ThemeToggle from '../components/shared/ThemeToggle'
import AIStatusBadge from '../components/shared/AIStatusBadge'
import AIReasoningPanel from '../components/shared/AIReasoningPanel'
import ConversationPanel from '../components/shared/ConversationPanel'
import { Scan, Cpu, Target, Map, Lightbulb, Sparkles } from 'lucide-react'
import { toast } from '../utils/toast'

type TabKey = 'overview' | 'diagnosis' | 'tasks' | 'authorization'

// 四个主入口 Tab 定义（成长闭环）
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: '成长总览' },
  { key: 'diagnosis', label: '诊断解释' },
  { key: 'tasks', label: '成长任务' },
  { key: 'authorization', label: '岗位授权' },
]

// 后端 dimension_scores 使用简称(key: tech/project/soft/domain)，前端用全称
const DIM_KEY_MAP: Record<string, string> = {
  tech: 'tech_skills',
  project: 'project_exp',
  soft: 'soft_skills',
  academic: 'academic_foundation',
  domain: 'domain_knowledge',
  soft_evidence: 'soft_skill_evidence',
  tech_skills: 'tech_skills',
  project_exp: 'project_exp',
  soft_skills: 'soft_skills',
  academic_foundation: 'academic_foundation',
  domain_knowledge: 'domain_knowledge',
  soft_skill_evidence: 'soft_skill_evidence',
}

// 从后端返回数据构建前端需要的 AbilityProfile 结构
const buildProfile = (result: any, studentData?: any): AbilityProfile => {
  if (result?.ability_profile || result?.profile) {
    const rawProfile = result.ability_profile || result.profile
    // ability_profile 中的 weight 是相对重要性权重（sum≈1.0），不是能力得分
    // 需要用 dimension_scores 覆盖 weight，确保雷达图展示的是实际能力分数
    const scores = result?.dimension_scores ?? {}
    const patched: any = {}
    for (const [key, value] of Object.entries(rawProfile as Record<string, any>)) {
      const mappedKey = DIM_KEY_MAP[key] ?? key
      const dimScore = scores[key] ?? scores[mappedKey]
      patched[key] = {
        ...(value as any),
        weight: typeof dimScore === 'number' ? dimScore : (value as any)?.weight ?? 0,
      }
    }
    return patched
  }

  interface SkillItem { name: string; score: number; level: string }

  const resolveDimScore = (dimKey: string): number => {
    const scores = result?.dimension_scores ?? {}
    const shortKey = Object.keys(DIM_KEY_MAP).find(k => DIM_KEY_MAP[k] === dimKey && (k.length <= 8 || k === 'soft_evidence')) ?? dimKey
    const val = scores[dimKey] ?? scores[shortKey] ?? 0
    return typeof val === 'number' ? val : 0
  }

  const makeDim = (dimKey: string): AbilityDimension => {
    const score = resolveDimScore(dimKey)
    const rawSkills = studentData?.[dimKey]

    let subItems: SkillItem[] = []

    if (dimKey === 'academic_foundation') {
      const courses = rawSkills?.core_courses
      if (Array.isArray(courses)) {
        subItems = courses.map((c: any) => ({
          name: c.name || '',
          score: typeof c.score === 'number' ? c.score : 60,
          level: typeof c.score === 'number' ? (c.score >= 85 ? '优秀' : c.score >= 75 ? '良好' : '及格') : '了解',
        }))
      }
    } else if (dimKey === 'soft_skill_evidence') {
      if (rawSkills && typeof rawSkills === 'object') {
        subItems = Object.entries(rawSkills as Record<string, any>).map(([name, details]) => ({
          name: name === 'teamwork' ? '团队协作' : name === 'communication' ? '沟通表达' : name === 'ownership' ? '主动性' : name,
          score: typeof details?.normalized_score === 'number' ? details.normalized_score : 60,
          level: details?.level || 'weak',
        }))
      }
    } else if (Array.isArray(rawSkills)) {
      subItems = (rawSkills as any[]).map((item: any) => ({
        name: item.name ?? item.role ?? '项目',
        score: 60,
        level: '了解',
      }))
    } else if (rawSkills && typeof rawSkills === 'object') {
      subItems = Object.entries(rawSkills as Record<string, number>).map(([name, val]) => ({
        name,
        score: typeof val === 'number' ? Math.round(val) : 60,
        level: typeof val === 'number' ? (val >= 80 ? '精通' : val >= 60 ? '熟练' : '了解') : '了解',
      }))
    }

    return { weight: score, sub_items: subItems }
  }

  return {
    tech_skills: makeDim('tech_skills'),
    project_exp: makeDim('project_exp'),
    academic_foundation: makeDim('academic_foundation'),
    domain_knowledge: makeDim('domain_knowledge'),
    soft_skill_evidence: makeDim('soft_skill_evidence'),
  }
}

// ─── SSE 共享工具函数 ───────────────────────────────

// 后端 stage 名称 → 前端步骤标签映射
const stageNameToLabel: Record<string, string> = {
  profile: '数据采集',
  match: '能力分析',
  gap: '岗位匹配',
  path: '路径规划',
  advice: '生成建议',
}

/** 根据 Agent Stream 进度回调更新 SSE 步骤状态和全局进度 */
const makeSseProgressUpdater = (
  setSseSteps: React.Dispatch<React.SetStateAction<{ label: string; status: 'wait' | 'process' | 'finish' | 'error' }[]>>,
  setProgress: (p: { stage: string; progress: number; message: string }) => void,
) => (stage: string, pct: number, msg: string) => {
  setProgress({ stage, progress: pct, message: msg })
  setSseSteps(prev => {
    // 先尝试精确匹配映射表，再 fallback 到 includes 模糊匹配
    const mappedLabel = stageNameToLabel[stage]
    const idx = mappedLabel
      ? prev.findIndex(s => s.label === mappedLabel)
      : prev.findIndex(s => s.label.includes(stage) || stage.includes(s.label))
    if (idx >= 0) {
      return prev.map((s, i) => ({
        ...s,
        status: i < idx ? 'finish' : i === idx ? 'process' : 'wait',
      }))
    }
    return prev
  })
}

/** 将后端 diagnosis_completed 数据解析为前端 DiagnosisResult */
const buildDiagnosisResultFromData = (
  data: any,
  studentId: number,
  overrides?: Partial<DiagnosisResult>
): DiagnosisResult => {
  const rawScores = data.dimension_scores ?? {}
  const dimension_scores: Record<string, number> = {}
  for (const [k, v] of Object.entries(rawScores)) {
    dimension_scores[DIM_KEY_MAP[k] ?? k] = v as number
  }
  const rawChanges = data.dimension_changes ?? {}
  const dimension_changes: Record<string, number> = {}
  for (const [k, v] of Object.entries(rawChanges)) {
    dimension_changes[DIM_KEY_MAP[k] ?? k] = v as number
  }
  const gp = data.growth_path
  return {
    id: data.id || '',
    student_id: studentId,
    version: data.version ?? 1,
    diagnosis_type: data.diagnosis_type || 'full',
    match_score: data.match_score ?? 0,
    dimension_scores,
    dimension_changes,
    gap_details: Array.isArray(data.gap_details) ? data.gap_details : [],
    top5_jobs: Array.isArray(data.top5_jobs) ? data.top5_jobs : [],
    growth_path: gp && typeof gp === 'object' ? { phases: Array.isArray(gp.phases) ? gp.phases : [] } : { phases: [] },
    career_advice: data.career_advice ?? '',
    ai_reasoning: data.ai_reasoning ?? {},
    reasoning: data.reasoning ?? '',
    ability_profile: data.ability_profile ?? null,
    explanations: data.explanations ?? null,
    confidence: data.confidence ?? null,
    ai_status: data.ai_status ?? 'available',
    trigger_event: data.trigger_event || '',
    created_at: data.created_at || new Date().toISOString(),
    ...overrides,
  }
}

/** 对从 API 直接返回的诊断历史做同样的防御性归一化 */
const normalizeDiagnosisResult = (raw: any): DiagnosisResult => {
  if (!raw || typeof raw !== 'object') return raw
  return buildDiagnosisResultFromData(raw, raw.student_id ?? 0, {
    id: raw.id,
    created_at: raw.created_at,
    ai_status: raw.ai_status,
  })
}

export default function Dashboard() {
  const navigate = useNavigate()
  const {
    student,
    diagnosisResult,
    diagnosisHistory,
    isLoading,
    progress,
    setStudent,
    setDiagnosisResult,
    setDiagnosisHistory,
    setIsLoading,
    setProgress,
    hydrateFromStorage,
  } = useAppStore()

  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnosisError, setDiagnosisError] = useState('')
  const [diagnosisSuccess, setDiagnosisSuccess] = useState(false)
  const [sseSteps, setSseSteps] = useState<{ label: string; status: 'wait' | 'process' | 'finish' | 'error' }[]>([])
  const [showReEval, setShowReEval] = useState(false)
  const [reEvalMsg, setReEvalMsg] = useState('')
  const [nextActions, setNextActions] = useState<NextAction[]>([])
  // 真实成长任务进度（从 GrowthTask API 加载，避免 OverviewTab 显示陈旧快照）
  const [taskStats, setTaskStats] = useState<{ completed: number; total: number } | null>(null)
  const [conversationOpen, setConversationOpen] = useState(false)

  // 区分初始化恢复状态，解决刷新重复诊断的 race condition
  const [hydrated, setHydrated] = useState(false)

  const staticSseSteps = [
    { label: '数据采集', status: 'wait' as const },
    { label: '能力分析', status: 'wait' as const },
    { label: '岗位匹配', status: 'wait' as const },
    { label: '路径规划', status: 'wait' as const },
    { label: '生成建议', status: 'wait' as const },
  ]

  const stepMeta: Record<string, { desc: string; icon: React.ReactNode }> = {
    '数据采集': { desc: '正在读取你的教育背景、技能经历和项目经验...', icon: <Scan size={16} /> },
    '能力分析': { desc: 'AI 正在从多维度评估你的核心竞争力...', icon: <Cpu size={16} /> },
    '岗位匹配': { desc: '基于能力画像匹配最适合你的职业方向...', icon: <Target size={16} /> },
    '路径规划': { desc: '正在为你生成个性化的成长路线图...', icon: <Map size={16} /> },
    '生成建议': { desc: '整合分析结果，输出完整的职业诊断报告...', icon: <Lightbulb size={16} /> },
  }

  // 处理 next_action 点击
  const handleNextAction = useCallback((action: NextAction) => {
    // 非导航类意图：映射到对应 Tab 或操作
    if (action.intent !== 'navigate') {
      switch (action.intent) {
        case 'diagnose':
          // 触发诊断：切到诊断 Tab 并提示
          setActiveTab('diagnosis')
          toast.info('正在准备诊断...')
          break
        case 'continue_growth':
          setActiveTab('tasks')
          break
        case 're_evaluate':
          setActiveTab('tasks')
          break
        case 'ask':
          setConversationOpen(true)
          break
        default:
          toast.info(action.label || '操作已记录')
      }
      return
    }
    const target = action.payload?.target
    switch (target) {
      case 'authorization_tab':
        setActiveTab('authorization')
        break
      case 'match_tab':
      case 'diagnosis':
        setActiveTab('diagnosis')
        break
      case 'growth_tab':
      case 'growth_tasks':
        setActiveTab('tasks')
        break
      case 'dashboard':
      case 'profile':
        setActiveTab('overview')
        break
      case 'profile_input':
        navigate('/student/input', { state: { fromDashboard: true } })
        break
      default:
        // 未知 target：给出反馈而非静默吞掉，便于联调发现契约不一致
        toast.info('该操作暂不支持，请稍后再试')
    }
  }, [navigate])

  // 执行初诊——通过 Agent Stream 统一入口
  const runDiagnosis = useCallback(async () => {
    if (!student) return
    setDiagnosing(true)
    setDiagnosisError('')
    setIsLoading(true)
    setSseSteps(staticSseSteps.map((s, i) => ({ ...s, status: i === 0 ? 'process' : 'wait' })))

    try {
      const result = await runStudentAgentStream(
        student.id, 'diagnose', {}, makeSseProgressUpdater(setSseSteps, setProgress)
      )

      setSseSteps(staticSseSteps.map(s => ({ ...s, status: 'finish' })))

      if (result.action === 'ask_for_info') {
        setAgentFollowup({
          questions: result.data?.followup_questions || [],
          completeness: result.data?.completeness ?? 0,
        })
      } else if (result.action === 'diagnosis_completed') {
        const diagResult = buildDiagnosisResultFromData(result.data || {}, student.id)
        setDiagnosisResult(diagResult)
        setActiveTab('diagnosis')
        setDiagnosisSuccess(true)
        setNextActions(result.next_actions || [])
        setTimeout(() => setDiagnosisSuccess(false), 4000)
      } else {
        setDiagnosisError('诊断返回了非预期的结果')
      }
    } catch (err: any) {
      const msg = err?.message || '诊断失败，请检查网络连接后重试'
      setSseSteps(prev => prev.map(s => ({ ...s, status: s.status === 'process' ? 'error' : s.status })))
      setDiagnosisError(msg)
    } finally {
      setIsLoading(false)
      setDiagnosing(false)
    }
  }, [student])

  // 执行再诊断——通过 Agent Stream 统一入口（手动复诊使用 diagnose intent）
  const handleReEvaluate = useCallback(async () => {
    if (!student) return
    setShowReEval(false)
    setDiagnosing(true)
    setIsLoading(true)
    setSseSteps(staticSseSteps.map((s, i) => ({ ...s, status: i === 0 ? 'process' : 'wait' })))

    try {
      const result = await runStudentAgentStream(
        student.id, 'diagnose', {}, makeSseProgressUpdater(setSseSteps, setProgress)
      )

      setSseSteps(staticSseSteps.map(s => ({ ...s, status: 'finish' })))

      if (result.action === 'diagnosis_completed') {
        const data = result.data || {}
        const diagResult = buildDiagnosisResultFromData(data, student.id, {
          version: data.version ?? (diagnosisResult ? diagnosisResult.version + 1 : 1),
          diagnosis_type: data.diagnosis_type || 'manual_rerun',
          trigger_event: data.trigger_event || '重新诊断',
        })

        if (diagnosisResult) {
          setDiagnosisHistory([...diagnosisHistory, diagnosisResult])
        }
        setDiagnosisResult(diagResult)
        setNextActions(result.next_actions || [])
        setActiveTab('diagnosis')
        setDiagnosisSuccess(true)
        setTimeout(() => setDiagnosisSuccess(false), 4000)
      } else {
        setDiagnosisError(result.message || '诊断返回了非预期的结果')
      }
    } catch (err: any) {
      const msg = err?.message || '再诊断失败，请稍后重试'
      setSseSteps(prev => prev.map(s => ({ ...s, status: s.status === 'process' ? 'error' : s.status })))
      setDiagnosisError(msg)
    } finally {
      setIsLoading(false)
      setDiagnosing(false)
    }
  }, [student, diagnosisResult, diagnosisHistory])

  // 1. 学生信息与历史恢复（防止 race condition）
  useEffect(() => {
    const init = async () => {
      const storedId = localStorage.getItem('student_id')
      if (storedId) {
        try {
          // 如果 store 中已有学生数据（刚从 ProfileInput 提交过来），跳过重复拉取
          const existingStudent = useAppStore.getState().student
          if (!existingStudent || String(existingStudent.id) !== String(storedId)) {
            const studentData = await getStudent(storedId)
            setStudent(studentData)
          }

          const history = await getDiagnosisHistory(storedId)
          if (history && history.length > 0) {
            const normalized = history.map(normalizeDiagnosisResult)
            setDiagnosisResult(normalized[0])
            setDiagnosisHistory(normalized)
          }
        } catch (e: any) {
          // 仅在认证失败（401/403）时清除会话，网络错误等不清除
          const status = e?.response?.status
          if (status === 401 || status === 403) {
            console.warn('认证失败，清除本地缓存:', e)
            localStorage.removeItem('student_id')
            localStorage.removeItem('zhida_student_id')
            localStorage.removeItem('student_data')
            localStorage.removeItem('zhida_token')
          } else {
            console.warn('恢复会话失败（非认证错误，保留会话）:', e)
          }
        }
      } else {
        hydrateFromStorage()
      }
      setHydrated(true)
    }
    init()
  }, [])

  // Agent 追问信息状态
  const [agentFollowup, setAgentFollowup] = useState<{
    questions: Array<{ question: string; field: string; priority: string }>
    completeness: number
  } | null>(null)

  // 防止 React StrictMode 或竞态导致重复触发诊断
  const diagnosisTriggeredRef = useRef(false)
  // 允许用户取消自动诊断
  const autoDiagnosisCancelledRef = useRef(false)

  // 2. 初始化恢复完成后，通过 Agent Stream API 判断是否需要诊断
  useEffect(() => {
    if (hydrated && student && !diagnosisResult && !diagnosing && !diagnosisTriggeredRef.current) {
      diagnosisTriggeredRef.current = true
      setDiagnosing(true)
      setIsLoading(true)
      setSseSteps(staticSseSteps.map((s, i) => ({ ...s, status: i === 0 ? 'process' : 'wait' })))

      runStudentAgentStream(student.id, 'diagnose', {}, makeSseProgressUpdater(setSseSteps, setProgress))
        .then((result) => {
          setDiagnosing(false)
          setIsLoading(false)
          // 用户已取消，忽略结果
          if (autoDiagnosisCancelledRef.current) return
          if (result.action === 'ask_for_info') {
            setAgentFollowup({
              questions: result.data?.followup_questions || [],
              completeness: result.data?.completeness ?? 0,
            })
          } else if (result.action === 'diagnosis_completed') {
            const diagResult = buildDiagnosisResultFromData(result.data || {}, student.id)
            setDiagnosisResult(diagResult)
            setActiveTab('diagnosis')
            setDiagnosisSuccess(true)
            setNextActions(result.next_actions || [])
            setTimeout(() => setDiagnosisSuccess(false), 4000)
          } else {
            setDiagnosisError(result.message || '诊断返回了非预期的结果')
          }
        })
        .catch((err) => {
          setDiagnosing(false)
          setIsLoading(false)
          if (autoDiagnosisCancelledRef.current) return
          const msg = err?.message || '诊断失败，请检查网络连接后重试'
          setDiagnosisError(msg)
        })
    }
  }, [hydrated, student, diagnosisResult, diagnosing, runDiagnosis])

  // 3. 诊断完成后加载历史记录
  useEffect(() => {
    if (student && diagnosisResult) {
      getDiagnosisHistory(student.id)
        .then((data: DiagnosisResult[]) => setDiagnosisHistory(
          Array.isArray(data) ? data.map(normalizeDiagnosisResult) : []
        ))
        .catch(() => { console.warn('加载诊断历史失败') })
    }
  }, [student, diagnosisResult])

  // 加载真实成长任务进度（供 OverviewTab 展示准确数字，而非诊断快照）
  useEffect(() => {
    if (!student || !diagnosisResult) return
    getGrowthTasks(student.id, diagnosisResult.id)
      .then((tasks: any[]) => {
        if (Array.isArray(tasks)) {
          const completed = tasks.filter((t) => t.status === 'completed').length
          setTaskStats({ completed, total: tasks.length })
        }
      })
      .catch(() => { /* 任务进度加载失败不阻塞主流程 */ })
  }, [student, diagnosisResult])



  if (!student) {
    return (
      <div className="bento-dashboard">
        <style>{`
          .bento-no-student-card {
            text-align: center;
            padding: var(--space-12);
            max-width: 440px;
            margin: auto;
          }
          .bento-no-student-card .btn {
            margin-top: var(--space-6);
          }
          .bento-no-student-icon {
            margin-bottom: var(--space-4);
          }
          .bento-no-student-title {
            font-size: 18px;
            font-weight: 600;
            color: var(--text-primary);
            font-family: var(--font-display);
            margin-bottom: var(--space-2);
          }
          .bento-no-student-desc {
            font-size: 13px;
            color: var(--text-secondary);
            line-height: 1.6;
          }
        `}</style>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
          <div className="surface-card bento-no-student-card">
            <div className="bento-no-student-icon">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--accent-warning)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <div className="bento-no-student-title">请先填写个人信息</div>
            <div className="bento-no-student-desc">
              完善你的教育背景和目标岗位，AI 才能为你提供精准诊断
            </div>
            <button
              className="btn btn-primary btn-lg"
              onClick={() => navigate('/student/input')}
            >
              前往填写
            </button>
          </div>
        </div>
      </div>
    )
  }

  const profile = diagnosisResult ? buildProfile(diagnosisResult, student) : null

  // 精确计算上一次诊断得分 (倒数第二个版本，即 version - 1)
  const sortedHistory = [...diagnosisHistory].sort((a, b) => b.version - a.version)
  const previousDiagnosis = diagnosisResult
    ? sortedHistory.find(h => h.version === (diagnosisResult.version - 1))
    : undefined
  const previousScore = previousDiagnosis?.match_score

  const renderTabContent = () => {
    if (diagnosing || (isLoading && !diagnosisResult)) {
      const steps = sseSteps.length > 0 ? sseSteps : staticSseSteps
      const activeIdx = steps.findIndex(s => s.status === 'process')
      const doneCount = steps.filter(s => s.status === 'finish').length
      const currentStep = steps[Math.max(0, activeIdx)]
      const meta = stepMeta[currentStep?.label]
      const pct = Math.round((doneCount / steps.length) * 100)

      return (
        <div className="diagnosis-loading">
          {/* AI 分析图标 */}
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'linear-gradient(135deg, rgba(var(--accent-primary-rgb), 0.15), rgba(var(--accent-primary-rgb), 0.05))',
            border: '2px solid rgba(var(--accent-primary-rgb), 0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: 'pulseGlow 2s ease-in-out infinite',
          }}>
            <Cpu size={28} style={{ color: 'var(--accent-primary)' }} />
          </div>

          {/* 阶段标题和描述 */}
          <div className="diagnosis-stage">
            <div className="diagnosis-stage-label">
              {meta?.icon}
              <span>{currentStep?.label ?? 'AI 正在分析你的能力画像...'}</span>
            </div>
            <div className="diagnosis-stage-desc">
              {meta?.desc ?? '正在初始化诊断引擎...'}
            </div>
          </div>

          {/* 进度条 + 百分比 */}
          <div style={{ width: '100%', maxWidth: 420, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="diagnosis-bar" style={{ flex: 1 }}>
              <div className="diagnosis-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span style={{
              fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)',
              color: pct >= 100 ? 'var(--accent-success)' : 'var(--accent-primary)',
              minWidth: 40, textAlign: 'right',
            }}>
              {pct}%
            </span>
          </div>

          {/* 步骤指示器 */}
          <ProgressSteps steps={steps} />

          {/* 进度文本 */}
          <div className="diagnosis-progress-text">
            {progress.message || `已完成 ${doneCount} / ${steps.length} 个步骤`}
          </div>

          {/* 取消按钮 */}
          {!diagnosisResult && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                autoDiagnosisCancelledRef.current = true
                setDiagnosing(false)
                setIsLoading(false)
                setDiagnosisError('')
                toast.info('已取消自动诊断，你可以稍后手动发起')
              }}
              style={{ marginTop: 4, fontSize: 12, color: 'var(--text-tertiary)', borderRadius: 'var(--radius-sm)' }}
            >
              取消诊断
            </button>
          )}
        </div>
      )
    }

    if (diagnosisError) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 24px' }}>
          <div className="surface-card" style={{ textAlign: 'center', padding: 'var(--space-10)', maxWidth: 480 }}>
            <div style={{ fontSize: 40, marginBottom: 'var(--space-4)' }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent-danger)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <div className="section-title" style={{ marginBottom: 'var(--space-2)' }}>诊断遇到问题</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 'var(--space-6)', maxWidth: 400, wordBreak: 'break-word', lineHeight: 1.6 }}>
              {diagnosisError}
            </div>
            <button
              className="btn btn-primary"
              onClick={() => { setDiagnosisError(''); runDiagnosis() }}
            >
              重新诊断
            </button>
          </div>
        </div>
      )
    }

    if (!diagnosisResult) {
      // Agent 追问信息不足
      if (agentFollowup) {
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 24px' }}>
            <div className="surface-card" style={{ textAlign: 'center', padding: 'var(--space-10)', maxWidth: 560 }}>
              <div style={{ fontSize: 40, marginBottom: 'var(--space-4)' }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent-warning)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
                </svg>
              </div>
              <div className="section-title" style={{ marginBottom: 'var(--space-2)' }}>需要补充一些信息</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 'var(--space-6)', lineHeight: 1.6 }}>
                当前信息完整度 {Math.round(agentFollowup.completeness * 100)}%，补充以下信息后诊断会更准确：
              </div>
              <div style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginBottom: 'var(--space-6)' }}>
                {agentFollowup.questions.map((q, i) => (
                  <div key={i} className="surface-card" style={{ padding: 'var(--space-3) var(--space-4)', borderLeft: '3px solid var(--accent-warning)' }}>
                    <div style={{ fontWeight: 600, marginBottom: 4, fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text-primary)' }}>
                      {q.priority === 'high'
                        ? <span className="status-badge status-badge-danger">高优先</span>
                        : <span className="status-badge status-badge-warning">中优先</span>
                      }{' '}
                      {q.question}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                      缺失字段: {q.field}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center' }}>
                <button
                  className="btn btn-primary"
                  onClick={() => navigate('/student/input', { state: { fromDashboard: true } })}
                >
                  去完善档案
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setAgentFollowup(null)}
                >
                  暂不诊断
                </button>
              </div>
            </div>
          </div>
        )
      }

      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 24px' }}>
          <div className="surface-card" style={{ textAlign: 'center', padding: 'var(--space-10)', maxWidth: 440 }}>
            <EmptyState
              icon="🔍"
              title="暂无诊断记录"
              description="点击上方按钮开始你的首次 AI 诊断"
            />
            <button
              className="btn btn-primary btn-lg"
              onClick={runDiagnosis}
              style={{ marginTop: 'var(--space-2)' }}
            >
              开始诊断
            </button>
          </div>
        </div>
      )
    }

    switch (activeTab) {
      case 'overview':
        return (
          <OverviewTab
            profile={profile!}
            dimensionChanges={diagnosisResult.dimension_changes}
            student={student!}
            growthPath={diagnosisResult.growth_path}
            diagnosisHistory={diagnosisHistory.length > 0 ? diagnosisHistory : [diagnosisResult]}
            taskStats={taskStats}
            onNavigateToTasks={() => setActiveTab('tasks')}
            onNavigateToDiagnosis={() => setActiveTab('diagnosis')}
          />
        )
      case 'diagnosis':
        return (
          <DiagnosisTab
            diagnosisResult={diagnosisResult}
            previousScore={previousScore}
          />
        )
      case 'tasks':
        return (
          <TasksTab
            growthPath={diagnosisResult.growth_path}
            diagnosisId={diagnosisResult.id}
            studentId={student?.id ?? ''}
            onTaskComplete={(taskId) => {
              toast.success('成长任务已完成，继续加油！')
            }}
            onReEvaluateComplete={async (newDiagnosisId: string) => {
              try {
                if (!student) return
                const history = await getDiagnosisHistory(student.id)
                if (history && history.length > 0) {
                  const normalized = history.map(normalizeDiagnosisResult)
                  // 计算匹配分变化，给用户正向反馈
                  const prevScore = diagnosisResult?.match_score ?? 0
                  const newScore = normalized[0]?.match_score ?? 0
                  const delta = newScore - prevScore
                  if (diagnosisResult) {
                    setDiagnosisHistory([...diagnosisHistory, diagnosisResult])
                  }
                  setDiagnosisResult(normalized[0])
                  setDiagnosisHistory(normalized)
                  // 更新 next_actions，让 AIReasoningPanel 的"下一步"按钮继续可用
                  setNextActions([
                    { label: '查看能力变化', intent: 'navigate', payload: { target: 'diagnosis' } },
                    { label: '继续成长任务', intent: 'continue_growth', payload: {} },
                  ])
                  // 自动跳转到诊断 Tab，让用户看到复评带来的提升
                  setActiveTab('diagnosis')
                  if (delta > 0.001) {
                    toast.success(`复评完成，匹配分提升 ${(delta * 100).toFixed(1)}%！`)
                  } else if (delta < -0.001) {
                    toast.info('复评完成，能力画像已更新')
                  } else {
                    toast.success('复评完成，能力画像已更新')
                  }
                }
                setReEvalMsg('复评完成，能力画像已更新。')
                setShowReEval(false)
              } catch {}
            }}
          />
        )
      case 'authorization':
        return (
          <AuthorizationPageTab
            student={student!}
            diagnosisResult={diagnosisResult}
          />
        )
      default:
        return null
    }
  }

  return (
    <div className="bento-dashboard">
      <style>{`
        .bento-topbar .btn-back:hover {
          border-color: var(--accent-primary);
          color: var(--accent-primary);
        }
        .bento-topbar .btn-rediagnose:hover {
          background: rgba(var(--accent-primary-rgb), 0.12);
          box-shadow: none;
        }
        .bento-success-toast .toast-action:hover {
          background: rgba(255,255,255,0.35);
        }
      `}</style>

      {/* Sticky top bar */}
      <div className="bento-topbar">
        <div className="bento-topbar-brand">
          <button className="brand-link" onClick={() => navigate('/')}>
            <span className="brand-link-mark"><Sparkles size={14} /></span>
            职达
          </button>
          <span className="brand-divider" />
          <button
            className="btn btn-ghost btn-sm btn-back"
            onClick={() => navigate('/student/input', { state: { fromDashboard: true } })}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            返回
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', marginLeft: 'var(--space-2)' }}>
            学生：<span style={{ color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'var(--font-display)' }}>{student.name}</span>
          </span>
          <span style={{
            fontSize: 11, color: 'var(--text-tertiary, #94a3b8)',
            marginLeft: 6,
            background: 'var(--bg-tertiary, #f1f5f9)',
            padding: '1px 6px', borderRadius: 4,
            fontFamily: 'var(--font-mono, monospace)',
          }}>
            ID: {student.id}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', marginLeft: 'var(--space-3)' }}>
            目标：<span className="tag tag-blue">{student.target_job || '未设置'}</span>
          </span>
        </div>
        <div className="bento-topbar-actions">
          {diagnosisResult && <AIStatusBadge aiStatus={diagnosisResult.ai_status} />}
          <ThemeToggle />
          <button
            className="btn btn-sm btn-rediagnose"
            onClick={() => { setReEvalMsg('是否基于当前成长数据重新进行诊断评估？'); setShowReEval(true) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              border: '1px solid var(--accent-primary)',
              background: 'rgba(var(--accent-primary-rgb), 0.08)',
              color: 'var(--accent-primary)',
              fontSize: 12, fontWeight: 600,
              fontFamily: 'var(--font-display)', letterSpacing: '0.5px',
              transition: 'all 0.25s ease',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            重新诊断
          </button>
        </div>
      </div>

      {/* Horizontal tab navigation */}
      <div className="bento-nav-tabs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`bento-nav-tab${activeTab === tab.key ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content area */}
      <div className="bento-content">
        <div style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>
          {/* AI 依据面板：仅在诊断/总览 Tab 显示，操作型 Tab（任务/授权）隐藏，避免挤压内容 */}
          {diagnosisResult?.reasoning && (activeTab === 'overview' || activeTab === 'diagnosis') && <AIReasoningPanel reasoning={diagnosisResult.reasoning} nextActions={nextActions} onNextAction={handleNextAction} />}
          {renderTabContent()}
        </div>
      </div>

      {diagnosisResult && (
        <ExportToolbar studentId={student.id} diagnosisId={diagnosisResult.id} version={diagnosisResult.version} />
      )}

      {diagnosisSuccess && (
        <div
          className="surface-card bento-success-toast"
          style={{
            position: 'fixed', bottom: 60, left: '50%', transform: 'translateX(-50%)', zIndex: 200,
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
            padding: 'var(--space-3) var(--space-6)',
            background: 'var(--accent-success)', color: '#fff',
            fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-display)',
            animation: 'slideUp 0.3s ease-out',
            border: 'none',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            诊断完成，结果已更新
          </span>
        </div>
      )}

      <ReEvaluatePrompt
        visible={showReEval}
        message={reEvalMsg}
        onReEvaluate={handleReEvaluate}
        onDismiss={() => setShowReEval(false)}
      />

      {/* Floating AI chat button */}
      <button
        onClick={() => setConversationOpen(true)}
        style={{
          position: 'fixed',
          bottom: 72,
          right: 24,
          width: 52,
          height: 52,
          borderRadius: '50%',
          border: 'none',
          background: 'var(--accent-primary, var(--accent-primary))',
          color: '#fff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 16px rgba(var(--accent-primary-rgb), 0.35)',
          zIndex: 997,
          transition: 'transform 0.2s, box-shadow 0.2s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'scale(1.08)'
          e.currentTarget.style.boxShadow = '0 6px 20px rgba(var(--accent-primary-rgb), 0.45)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)'
          e.currentTarget.style.boxShadow = '0 4px 16px rgba(var(--accent-primary-rgb), 0.35)'
        }}
        title="AI 助手对话"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {/* Conversation panel drawer */}
      <ConversationPanel
        studentId={student.id}
        open={conversationOpen}
        onClose={() => setConversationOpen(false)}
      />
    </div>
  )
}
