'use client'

import { formatPoints } from '@/lib/pricing'


interface EnergyRingProps {
  points: number
  totalConsumed: number
  size?: number
}

/**
 * 双环能量圈：外环=历史消耗(绿/黄/红随比例)，内环=当前剩余(蓝)。
 * 中心显示积分余额与已消耗。
 */
export function EnergyRing({ points, totalConsumed, size = 180 }: EnergyRingProps) {
  const total = points + totalConsumed
  const consumedPct = total > 0 ? totalConsumed / total : 0
  const pointsPct = total > 0 ? points / total : 0

  // 外环颜色：消耗 <50% 绿 / 50-80% 黄 / >80% 红
  const consumedColor = consumedPct < 0.5 ? '#52C41A' : consumedPct < 0.8 ? '#FAAD14' : '#FF4D4F'
  const trackColor = '#F0F0F0'
  const pointsColor = '#1677FF'

  const outerR = 54
  const outerStroke = 12
  const innerR = 36
  const innerStroke = 8
  const cx = 70
  const cy = 70
  const viewBoxSize = 140

  const outerCircumference = 2 * Math.PI * outerR
  const innerCircumference = 2 * Math.PI * innerR
  const outerDash = outerCircumference * consumedPct
  const innerDash = innerCircumference * pointsPct

  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}>
        {/* 外环轨道 + 进度（消耗） */}
        <circle cx={cx} cy={cy} r={outerR} fill="none" stroke={trackColor} strokeWidth={outerStroke} />
        <circle
          cx={cx} cy={cy} r={outerR} fill="none" stroke={consumedColor} strokeWidth={outerStroke}
          strokeLinecap="round"
          strokeDasharray={`${outerDash} ${outerCircumference - outerDash}`}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ transition: 'stroke-dasharray 0.6s ease, stroke 0.3s' }}
        />
        {/* 内环轨道 + 进度（剩余） */}
        <circle cx={cx} cy={cy} r={innerR} fill="none" stroke={trackColor} strokeWidth={innerStroke} />
        <circle
          cx={cx} cy={cy} r={innerR} fill="none" stroke={pointsColor} strokeWidth={innerStroke}
          strokeLinecap="round"
          strokeDasharray={`${innerDash} ${innerCircumference - innerDash}`}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ transition: 'stroke-dasharray 0.6s ease' }}
        />
        {/* 中心文字 */}
        <text x={cx} y={cy - 4} textAnchor="middle" className="fill-foreground" style={{ fontSize: 22, fontWeight: 700 }}>
          {formatPoints(points)}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="fill-text-secondary" style={{ fontSize: 8 }}>
          可用积分
        </text>
      </svg>
      <div className="flex items-center gap-4 mt-2 text-xs">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: pointsColor }} />
          <span className="text-text-muted">剩余 {formatPoints(points)}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: consumedColor }} />
          <span className="text-text-muted">已耗 {totalConsumed}</span>
        </span>
      </div>
    </div>
  )
}
