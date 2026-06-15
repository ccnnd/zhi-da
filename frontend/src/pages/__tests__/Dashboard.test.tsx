// Dashboard 诊断行为验证测试
// 验证: 自动诊断 Agent Stream、手动复诊 diagnose intent、ask_for_info、错误处理
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useAppStore } from '../../stores/appStore'

// Mock API
vi.mock('../../services/api', () => ({
  getDiagnosisHistory: vi.fn().mockResolvedValue([]),
  getStudent: vi.fn(),
  runStudentAgent: vi.fn(),
  runStudentAgentStream: vi.fn(),
  getGrowthTasks: vi.fn().mockResolvedValue([]),
}))

// Mock 子组件
vi.mock('../../components/shared/ProgressSteps', () => ({ default: () => <div data-testid="progress-steps" /> }))
vi.mock('../../components/shared/ReEvaluatePrompt', () => ({
  default: ({ visible, onReEvaluate }: any) =>
    visible ? <div role="dialog"><button onClick={onReEvaluate}>确认复评</button></div> : null,
}))
vi.mock('../../components/export/ExportToolbar', () => ({ default: () => null }))
vi.mock('../../components/diagnosis/ProfileTab', () => ({ default: () => <div>能力画像</div> }))
vi.mock('../../components/diagnosis/MatchTab', () => ({ default: () => <div>岗位匹配</div> }))
vi.mock('../../components/diagnosis/PathTab', () => ({ default: () => <div>成长路径</div> }))
vi.mock('../../components/diagnosis/AdviceTab', () => ({ default: () => <div>职业建议</div> }))
vi.mock('../../components/diagnosis/RecommendTab', () => ({ default: () => <div>就业推荐</div> }))
vi.mock('../../components/diagnosis/GrowthTab', () => ({ default: () => <div>成长追踪</div> }))
vi.mock('../../components/diagnosis/AuthorizationTab', () => ({ default: () => <div>授权管理</div> }))
vi.mock('../../components/shared/ThemeToggle', () => ({ default: () => null }))
vi.mock('../../components/shared/AIStatusBadge', () => ({ default: () => null }))
vi.mock('../../components/shared/AIReasoningPanel', () => ({ default: () => null }))

import Dashboard from '../../pages/Dashboard'
import { runStudentAgentStream, getDiagnosisHistory } from '../../services/api'

const mockedStream = vi.mocked(runStudentAgentStream)
const mockedHistory = vi.mocked(getDiagnosisHistory)

// 测试数据
const mockStudent = {
  id: 1001, name: '张三', grade: '大三', major: '计算机',
  target_job: 'Python开发', tech_skills: { Python: 70 },
  project_exp: [], soft_skills: {}, domain_knowledge: {}, resume_text: '',
}

const mockDiagResult = {
  id: 'diag-1', student_id: 1001, version: 1, diagnosis_type: 'full',
  match_score: 75, dimension_scores: { tech: 0.7 }, dimension_changes: {},
  gap_details: [], top5_jobs: [], growth_path: { phases: [] },
  career_advice: '建议...', ai_reasoning: {}, trigger_event: '初诊',
  created_at: '2026-01-01', ai_status: 'available' as const,
}

const completedResult = {
  action: 'diagnosis_completed' as const,
  message: '诊断完成',
  data: {
    id: 'diag-new', version: 2, dimension_scores: { tech: 0.8 },
    dimension_changes: {}, match_score: 80, gap_details: [], top5_jobs: [],
    growth_path: { phases: [] }, career_advice: '新建议', ai_reasoning: {},
    ai_status: 'available', diagnosis_type: 'full',
  },
  next_actions: [],
  ai_status: 'available' as const,
}

function renderDashboard() {
  return render(<MemoryRouter><Dashboard /></MemoryRouter>)
}

describe('Dashboard - Agent Stream 诊断行为验证', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedHistory.mockResolvedValue([])
    useAppStore.setState({
      student: null,
      diagnosisResult: null,
      diagnosisHistory: [],
      isLoading: false,
      progress: { stage: '', progress: 0, message: '' },
      triggeredReEvaluate: false,
    })
    localStorage.clear()
  })

  it('自动诊断使用 Agent Stream + diagnose intent', async () => {
    useAppStore.setState({ student: mockStudent as any })
    mockedStream.mockResolvedValue(completedResult)

    renderDashboard()

    await waitFor(() => {
      expect(mockedStream).toHaveBeenCalledWith(
        1001, 'diagnose', {}, expect.any(Function),
      )
    })
  })

  it('ask_for_info 展示追问面板', async () => {
    useAppStore.setState({ student: mockStudent as any })
    mockedStream.mockResolvedValue({
      action: 'ask_for_info' as const,
      message: '需要更多信息',
      data: {
        followup_questions: [
          { question: '请填写项目经验', field: 'project_exp', priority: 'high' },
        ],
        completeness: 0.6,
      },
      next_actions: [],
      ai_status: 'available' as const,
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByText(/需要补充一些信息/)).toBeTruthy()
    })
    expect(screen.getByText(/请填写项目经验/)).toBeTruthy()
    expect(screen.getByText(/60%/)).toBeTruthy() // completeness 0.6 → 60%
  })

  it('Agent Stream 失败时显示错误信息', async () => {
    useAppStore.setState({ student: mockStudent as any })
    mockedStream.mockRejectedValue(new Error('网络连接超时'))

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByText(/诊断遇到问题/)).toBeTruthy()
    })
    expect(screen.getByText(/网络连接超时/)).toBeTruthy()
  })

  it('手动复诊使用 diagnose intent（非 re_evaluate）', async () => {
    // 已有诊断结果 → 不会触发自动诊断
    useAppStore.setState({
      student: mockStudent as any,
      diagnosisResult: mockDiagResult as any,
    })
    mockedStream.mockResolvedValue(completedResult)

    renderDashboard()

    // 等待初始渲染稳定
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    mockedStream.mockClear()

    // 点击头部「重新诊断」按钮
    const reDiagBtn = screen.getByText('重新诊断')
    fireEvent.click(reDiagBtn)

    // ReEvaluatePrompt 弹出，点击确认
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('确认复评'))

    // 验证: runStudentAgentStream 被调用，intent='diagnose'（非 're_evaluate'）
    await waitFor(() => {
      expect(mockedStream).toHaveBeenCalledWith(
        1001, 'diagnose', {}, expect.any(Function),
      )
    })
  })
})
