// 横向阶段时间线——已完成(绿)/当前(蓝)/未开始(灰)三种节点状态
import type { FC } from 'react'
import type { GrowthPhase } from '../../types'

interface Props {
  phases: GrowthPhase[]
  currentPhase?: number
  completedPhases?: boolean[]
}

const PathTimeline: FC<Props> = ({ phases, currentPhase = -1, completedPhases }) => {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8px 0 24px', position: 'relative' }}>
      {phases.map((phase, i) => {
        const isCompleted = completedPhases ? completedPhases[i] : i < currentPhase
        const isCurrent = completedPhases ? (i === currentPhase && currentPhase >= 0) : i === currentPhase
        const isFuture = !isCompleted && !isCurrent

        const nodeStyle: React.CSSProperties = {
          width: 24,
          height: 24,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          border: isCompleted
            ? '2px solid var(--accent-success)'
            : isCurrent
              ? '2px solid var(--accent-primary)'
              : '2px solid var(--text-tertiary)',
          background: isCompleted
            ? 'var(--accent-success)'
            : isCurrent
              ? 'rgba(var(--accent-primary-rgb), 0.2)'
              : 'transparent',
          color: isCompleted ? '#fafaf8' : isCurrent ? 'var(--accent-primary)' : 'var(--text-tertiary)',
          fontWeight: 700,
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          transition: 'all 0.3s ease',
          animation: isCurrent ? 'pulseGlow 1.5s ease-in-out infinite' : 'none',
        }

        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, position: 'relative' }}>
            <div style={{
              display: 'flex', alignItems: 'center', width: '100%',
              justifyContent: i === 0 ? 'flex-start' : i === phases.length - 1 ? 'flex-end' : 'center',
            }}>
              {i > 0 && (
                <div style={{
                  position: 'absolute',
                  left: 0,
                  right: '50%',
                  top: 11,
                  height: 2,
                  background: (completedPhases?.[i - 1])
                    ? (isCurrent
                      ? 'linear-gradient(to right, var(--accent-success), var(--accent-primary))'
                      : 'var(--accent-success)')
                    : 'var(--border-light)',
                  zIndex: 0,
                }} />
              )}
              {i < phases.length - 1 && (
                <div style={{
                  position: 'absolute',
                  left: '50%',
                  right: 0,
                  top: 11,
                  height: 2,
                  background: isCompleted
                    ? 'var(--accent-success)'
                    : isCurrent
                      ? 'linear-gradient(to right, var(--accent-primary), var(--border-light))'
                      : 'var(--border-light)',
                  zIndex: 0,
                }} />
              )}
              <div style={{ ...nodeStyle, position: 'relative', zIndex: 1 }}>
                {isCompleted ? '✓' : isCurrent ? '' : i + 1}
                {isCurrent && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-primary)' }} />}
              </div>
            </div>
            <span style={{
              marginTop: 8,
              fontSize: 11,
              color: isFuture ? 'var(--text-tertiary)' : 'var(--text-primary)',
              textAlign: 'center',
              fontFamily: 'var(--font-display)',
              fontWeight: isCurrent ? 600 : 400,
              maxWidth: 120,
              lineHeight: 1.3,
            }}>
              {phase.goal}
            </span>
            <span style={{
              fontSize: 10,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
              marginTop: 2,
            }}>
              {phase.weeks}周
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default PathTimeline
