// 岗位授权 Tab——授权管理（岗位推荐已在「诊断解释」Tab 展示，此处不重复）
import type { FC } from 'react'
import type { DiagnosisResult, Student } from '../../types'
import AuthorizationTab from '../../components/diagnosis/AuthorizationTab'

interface AuthorizationPageTabProps {
  student: Student
  diagnosisResult: DiagnosisResult
}

const AuthorizationPageTab: FC<AuthorizationPageTabProps> = ({
  student,
  diagnosisResult,
}) => {
  const jobCount = (diagnosisResult.top5_jobs || []).length
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xl)' }}>
      {jobCount > 0 && (
        <div className="surface-card" style={{ padding: 'var(--space-4) var(--space-5)', display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span style={{ fontSize: 22 }}>💡</span>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            基于诊断已为你推荐 <strong style={{ color: 'var(--accent-primary)' }}>{jobCount}</strong> 个匹配岗位，
            下方可一键授权企业查看你的能力画像。岗位详情请前往「诊断解释」Tab 查看。
          </span>
        </div>
      )}
      <AuthorizationTab
        student={student}
        diagnosisResult={diagnosisResult}
      />
    </div>
  )
}

export default AuthorizationPageTab
