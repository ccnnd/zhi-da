// ECharts 半圆仪表盘——三段色(玫瑰→琥珀→绿)，支持 previousScore 变化箭头
import ReactECharts from 'echarts-for-react'
import { useAppStore } from '../../stores/appStore'

interface MatchGaugeProps {
  score: number
  previousScore?: number
  label?: string
}

const containerStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  background: 'transparent',
  borderRadius: 12,
  boxSizing: 'border-box',
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
}

// 解析 CSS 变量为实际颜色值（ECharts Canvas 不支持 CSS 自定义属性）
const resolveCssVar = (varName: string, fallback: string): string => {
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return val || fallback
}

export default function MatchGauge({ score, previousScore, label }: MatchGaugeProps) {
  const { theme } = useAppStore()
  const isDark = theme === 'dark'

  const textColor = isDark ? '#a0a5b5' : '#6e6e73'
  const detailColor = isDark ? '#f5f6f9' : '#1d1d1f'
  const anchorBorderColor = isDark ? '#16181d' : '#ffffff'

  // ECharts 渲染到 Canvas，必须使用实际颜色值而非 CSS 变量
  // fallback 值与 index.css 中 --accent-* 变量的亮色模式值一致
  const roseColor = resolveCssVar('--accent-danger', '#ff3b30')
  const amberColor = resolveCssVar('--accent-warning', '#ff9f0a')
  const greenColor = resolveCssVar('--accent-success', '#34c759')

  const percent = Math.round(score * 100)
  const delta = previousScore !== undefined ? Math.round((score - previousScore) * 100) : null
  const isUp = delta !== null && delta > 0
  const isDown = delta !== null && delta < 0

  const option = {
    backgroundColor: 'transparent',
    series: [
      {
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        center: ['50%', '60%'],
        radius: '90%',
        min: 0,
        max: 100,
        splitNumber: 10,
        axisLine: {
          show: true,
          lineStyle: {
            width: 18,
            color: [
              [0.4, roseColor],
              [0.7, amberColor],
              [1, greenColor],
            ],
            shadowBlur: 8,
            shadowColor: isDark ? 'rgba(0, 0, 0, 0.4)' : 'rgba(91, 123, 181, 0.2)',
            shadowOffsetX: 0,
            shadowOffsetY: 0,
          },
        },
        pointer: {
          icon: 'path://M12.8,0.7l12,40.1H0.7L12.8,0.7z',
          length: '60%',
          width: 6,
          offsetCenter: [0, '-14%'],
          itemStyle: {
            color: 'auto',
          },
        },
        axisTick: {
          length: 10,
          lineStyle: {
            color: 'auto',
            width: 1,
          },
          distance: -20,
        },
        splitLine: {
          length: 22,
          lineStyle: {
            color: 'auto',
            width: 3,
          },
          distance: -22,
        },
        axisLabel: {
          color: textColor,
          distance: 30,
          fontSize: 11,
          fontFamily: 'Noto Sans SC, -apple-system, sans-serif',
        },
        anchor: {
          show: true,
          showAbove: true,
          size: 16,
          itemStyle: {
            borderColor: anchorBorderColor,
            borderWidth: 3,
            color: resolveCssVar('--accent-primary', '#0071e3'),
          },
        },
        title: {
          show: false,
        },
        detail: {
          valueAnimation: true,
          formatter: '{value}%',
          color: detailColor,
          fontSize: 32,
          fontFamily: 'Noto Sans SC, -apple-system, sans-serif',
          fontWeight: 'bold',
          offsetCenter: [0, '50%'],
        },
        data: [
          {
            value: percent,
          },
        ],
      },
    ],
  }

  return (
    <div style={containerStyle}>
      {label && (
        <div style={{
          color: 'var(--text-secondary)',
          fontSize: 14,
          textAlign: 'center',
          position: 'absolute',
          top: 22,
          left: '50%',
          transform: 'translateX(-50%)',
        }}>
          {label}
        </div>
      )}
      <ReactECharts
        option={option}
        style={{ width: '100%', height: '100%' }}
        opts={{ renderer: 'canvas' }}
      />
      {delta !== null && delta !== 0 && (
        <div style={{
          position: 'absolute',
          bottom: 18,
          left: '50%',
          transform: 'translateX(-50%)',
          fontFamily: 'var(--font-display)',
          fontSize: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span style={{ color: isUp ? 'var(--accent-success)' : 'var(--accent-danger)', fontSize: 20 }}>
            {isUp ? '▲' : '▼'}
          </span>
          <span style={{ color: isUp ? 'var(--accent-success)' : 'var(--accent-danger)', fontWeight: 600 }}>
            {isUp ? '+' : ''}{delta}%
          </span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>较上次</span>
        </div>
      )}
    </div>
  )
}
