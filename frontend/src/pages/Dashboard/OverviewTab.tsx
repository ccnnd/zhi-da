// 成长总览 Tab——整合 ProfileTab（能力画像）和 GrowthTab（成长趋势追踪）
import type { FC } from 'react'
import type { AbilityProfile, Student, DiagnosisResult } from '../../types'
import ProfileTab from '../../components/diagnosis/ProfileTab'
import GrowthTab from '../../components/diagnosis/GrowthTab'

interface OverviewTabProps {
  profile: AbilityProfile
  dimensionChanges: Record<string, number>
  student: Student
  growthPath: { phases: Array<any> }
  diagnosisHistory: DiagnosisResult[]
  /** 真实成长任务进度（来自 GrowthTask API）；为 null 时回退到 growthPath 快照 */
  taskStats?: { completed: number; total: number } | null
  /** 跳转到成长任务 Tab */
  onNavigateToTasks?: () => void
  /** 跳转到诊断解释 Tab */
  onNavigateToDiagnosis?: () => void
}

const OverviewTab: FC<OverviewTabProps> = ({
  profile,
  dimensionChanges,
  student,
  growthPath,
  diagnosisHistory,
  taskStats,
  onNavigateToTasks,
  onNavigateToDiagnosis,
}) => {
  const hasTasks = growthPath?.phases && growthPath.phases.length > 0
  // 优先使用真实任务进度（来自 API），回退到 growthPath 快照
  const allTasks = (growthPath?.phases || []).flatMap((p: any) => p?.tasks || [])
  const snapshotCompleted = allTasks.filter((t: any) => t?.status === 'completed').length
  const completedCount = taskStats ? taskStats.completed : snapshotCompleted
  const totalCount = taskStats ? taskStats.total : allTasks.length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xl)' }}>
      <ProfileTab
        profile={profile}
        changes={dimensionChanges}
        student={student}
      />

      {/* 任务进度摘要卡——把总览和成长任务 Tab 用数据连起来 */}
      <div className="surface-card" style={{ padding: 'var(--space-5)', display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
        <div style={{
          width: 44, height: 44, borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, flexShrink: 0,
        }}>🎯</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-display)', marginBottom: 4 }}>
            {hasTasks ? `成长任务进度 ${completedCount}/${totalCount}` : '暂无成长任务'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {hasTasks
              ? (completedCount === totalCount && totalCount > 0
                  ? '全部任务已完成，建议触发复评量化能力提升'
                  : `还有 ${totalCount - completedCount} 个任务待完成，完成后可触发复评`)
              : '本次诊断未生成成长任务，可尝试重新诊断'}
          </div>
        </div>
        {onNavigateToTasks && (
          <button className="btn btn-primary btn-sm" onClick={onNavigateToTasks} style={{ flexShrink: 0 }}>
            查看成长任务
          </button>
        )}
      </div>

      <GrowthTab history={diagnosisHistory} onNavigateToDiagnosis={onNavigateToDiagnosis} />
    </div>
  )
}

export default OverviewTab
