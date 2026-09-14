import { useEffect, useRef, useState } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts'

type RecentPickCombo = { umabanCombo: string; names: string; probability: number }
type PredictionBreakdown = {
  recentForm: number
  distanceAptitude: number
  surfaceAptitude: number
  trackConditionAptitude: number
  classAdequacy: number
  jockeyContinuity: number
  condition: number
  pedigree: number
  market: number
}
type AxisAnalysis = {
  umaban: number
  horseName: string
  winProbability: number
  runningStyle: string
  breakdown: PredictionBreakdown
  summary: string
}
type RecentPick = {
  raceId: string
  raceName: string
  course: string
  venue: string
  raceDate: string
  predictedAt: string
  confidence: string | null
  probabilityGap: number | null
  confidenceScore: number | null
  betsByType: Record<string, RecentPickCombo[]>
  axisAnalysis: AxisAnalysis | null
}

const FACTOR_LABELS: Record<keyof PredictionBreakdown, string> = {
  recentForm: '近走成績',
  distanceAptitude: '距離適性',
  surfaceAptitude: '馬場適性(芝/ダート)',
  trackConditionAptitude: '馬場状態適性',
  classAdequacy: 'クラス適性',
  jockeyContinuity: '騎手相性',
  condition: '馬体重・調子',
  pedigree: '血統評価',
  market: '市場評価(人気)',
}
const FACTOR_ORDER: (keyof PredictionBreakdown)[] = [
  'recentForm',
  'distanceAptitude',
  'surfaceAptitude',
  'trackConditionAptitude',
  'classAdequacy',
  'jockeyContinuity',
  'condition',
  'pedigree',
  'market',
]

function confidenceScoreClass(score: number) {
  if (score >= 80) return 'text-success'
  if (score >= 60) return 'text-primary'
  return 'text-danger'
}

function formatRaceDate(dateStr: string) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  return d.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })
}

type BatchJob = {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  raceIds: string[]
  error?: string
}

const BET_TYPE_LABELS: Record<string, string> = {
  tansho: '単勝',
  fukusho: '複勝',
  umaren: '馬連',
  wide: 'ワイド',
  umatan: '馬単',
  sanrenpuku: '三連複',
  sanrentan: '三連単',
}
const BET_TYPE_ORDER = ['tansho', 'fukusho', 'umaren', 'wide', 'umatan', 'sanrenpuku', 'sanrentan']

function confidenceBadgeClass(confidence: string | null) {
  if (confidence === '堅い') return 'bg-success'
  if (confidence === 'やや堅い') return 'bg-primary'
  if (confidence === '混戦') return 'bg-danger'
  return 'bg-secondary'
}

function RecentPicksSection() {
  const [picks, setPicks] = useState<RecentPick[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<BatchJob | null>(null)
  const [expandedRaceId, setExpandedRaceId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function loadPicks() {
    setLoading(true)
    try {
      const res = await fetch('/api/dashboard/recent-picks?limit=4')
      const json = await res.json()
      setPicks(json.picks)
    } catch {
      setError('直近の予想の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPicks()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  async function handleFetchRaces() {
    setError(null)
    try {
      const res = await fetch('/api/batch-predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 4 }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || '開始に失敗しました')

      pollRef.current = setInterval(async () => {
        const statusRes = await fetch(`/api/batch-predict/${json.jobId}`)
        const statusJson: BatchJob = await statusRes.json()
        setJob(statusJson)
        if (statusJson.status !== 'running') {
          if (pollRef.current) clearInterval(pollRef.current)
          if (statusJson.status === 'done') loadPicks()
        }
      }, 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '開始に失敗しました')
    }
  }

  const isRunning = job?.status === 'running'

  return (
    <div className="card border-0 shadow-sm mb-4">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h2 className="h6 fw-bold mb-0">直近の自信がある買い目</h2>
          <button type="button" className="btn btn-sm btn-primary" disabled={isRunning} onClick={handleFetchRaces}>
            {isRunning ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" role="status" />
                取得中 {job?.completed}/{job?.total || '?'}
              </>
            ) : (
              '開催予定レースを取得して予想'
            )}
          </button>
        </div>

        {error && <div className="alert alert-danger py-2 small">{error}</div>}
        {job?.status === 'error' && (
          <div className="alert alert-danger py-2 small">取得中にエラーが発生しました: {job.error}</div>
        )}
        {isRunning && (
          <p className="text-muted small">
            出走馬ごとに過去成績・血統を取得するため、レース1件あたり数十秒〜数分かかります。このまま他の画面を見ても構いません。
          </p>
        )}

        {loading ? (
          <p className="text-muted small mb-0">読み込み中...</p>
        ) : picks.length === 0 ? (
          <p className="text-muted small mb-0">
            まだ予想履歴がありません。上のボタンで開催予定レースを取得するか、/predict で個別に予想してください。
          </p>
        ) : (
          <div className="row g-3">
            {picks.map((p) => {
              const isExpanded = expandedRaceId === p.raceId
              return (
                <div className="col-md-6" key={p.raceId}>
                  <div
                    className="border rounded p-3 h-100"
                    role="button"
                    onClick={() => setExpandedRaceId(isExpanded ? null : p.raceId)}
                  >
                    <div className="d-flex align-items-center gap-2 mb-1 flex-wrap">
                      <span className="fw-semibold small">{p.raceName || p.raceId}</span>
                      {p.confidence && (
                        <span className={`badge ${confidenceBadgeClass(p.confidence)}`}>{p.confidence}</span>
                      )}
                      {p.confidenceScore != null && (
                        <span className={`small fw-bold ${confidenceScoreClass(p.confidenceScore)}`}>
                          確度 {p.confidenceScore}
                          <span className="text-muted fw-normal">/100</span>
                        </span>
                      )}
                      <i className={`bi ${isExpanded ? 'bi-chevron-up' : 'bi-chevron-down'} text-muted ms-auto`} />
                    </div>
                    <div className="text-muted small mb-2">
                      {formatRaceDate(p.raceDate)}
                      {p.venue && ` ${p.venue}`}
                      {' ・ '}
                      {p.course}
                    </div>
                    {BET_TYPE_ORDER.filter((t) => p.betsByType[t]?.length).map((t) => (
                      <div key={t} className="small mb-1">
                        <span className="text-muted me-1">{BET_TYPE_LABELS[t]}:</span>
                        {p.betsByType[t].slice(0, 2).map((c) => (
                          <span key={c.umabanCombo} className="badge bg-light text-dark border me-1 fw-normal">
                            {c.umabanCombo} ({(c.probability * 100).toFixed(1)}%)
                          </span>
                        ))}
                      </div>
                    ))}

                    {isExpanded && (
                      <div className="mt-2 pt-2 border-top" onClick={(e) => e.stopPropagation()}>
                        {p.axisAnalysis ? (
                          <>
                            <p className="small mb-2">{p.axisAnalysis.summary}</p>
                            <div className="d-flex flex-column gap-1">
                              {FACTOR_ORDER.map((key) => {
                                const score = Math.round(p.axisAnalysis!.breakdown[key])
                                return (
                                  <div key={key} className="d-flex align-items-center gap-2">
                                    <span className="text-muted small" style={{ width: 150, flexShrink: 0 }}>
                                      {FACTOR_LABELS[key]}
                                    </span>
                                    <div className="progress flex-grow-1" style={{ height: 6 }}>
                                      <div
                                        className={`progress-bar ${score >= 60 ? 'bg-success' : score < 45 ? 'bg-danger' : 'bg-secondary'}`}
                                        style={{ width: `${score}%` }}
                                      />
                                    </div>
                                    <span className="small text-muted" style={{ width: 28, textAlign: 'right' }}>
                                      {score}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          </>
                        ) : (
                          <p className="text-muted small mb-0">この予想の詳細データはありません(旧バージョンの予想)。</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

type Granularity = 'day' | 'month'

type StatsPeriodPoint = {
  period: string
  attempts: number
  hits: number
  totalPayout: number
  returnRate: number
  cumulativeReturnRate: number
}

type BetTypeStats = {
  betType: string
  attempts: number
  hits: number
  hitRate: number
  totalPayout: number
  returnRate: number
}

const NAVY = '#0b1f3a'
const GOLD = '#b8860b'
const GOLD_BRIGHT = '#d4af37'

function formatPeriodLabel(period: string, granularity: Granularity) {
  if (granularity === 'month') {
    const [, m] = period.split('-')
    return `${Number(m)}月`
  }
  const [, m, d] = period.split('-')
  return `${Number(m)}/${Number(d)}`
}

function GranularityToggle({ value, onChange }: { value: Granularity; onChange: (g: Granularity) => void }) {
  return (
    <div className="btn-group btn-group-sm" role="group">
      <button
        type="button"
        className={`btn ${value === 'day' ? 'btn-dark' : 'btn-outline-dark'}`}
        onClick={() => onChange('day')}
      >
        日別
      </button>
      <button
        type="button"
        className={`btn ${value === 'month' ? 'btn-dark' : 'btn-outline-dark'}`}
        onClick={() => onChange('month')}
      >
        月別
      </button>
    </div>
  )
}

function ChartEmptyState() {
  return (
    <div className="d-flex align-items-center justify-content-center text-muted small" style={{ height: 260 }}>
      まだ結果確定済みのデータがありません
    </div>
  )
}

function CumulativeReturnCard({ granularity, points, loading }: { granularity: Granularity; points: StatsPeriodPoint[]; loading: boolean }) {
  const data = points.map((p) => ({ ...p, label: formatPeriodLabel(p.period, granularity) }))
  return (
    <div className="card border-0 shadow-sm h-100">
      <div className="card-body">
        <h2 className="h6 fw-bold mb-3">累積回収率の推移</h2>
        {loading ? (
          <div className="text-muted small text-center py-5">読み込み中...</div>
        ) : data.length === 0 ? (
          <ChartEmptyState />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
              <defs>
                <linearGradient id="goldFade" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={GOLD_BRIGHT} stopOpacity={0.6} />
                  <stop offset="100%" stopColor={GOLD_BRIGHT} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="#9ca3af" />
              <YAxis tick={{ fontSize: 12 }} stroke="#9ca3af" unit="%" />
              <Tooltip formatter={(v) => [`${v}%`, '累積回収率']} />
              <ReferenceLine y={100} stroke="#9ca3af" strokeDasharray="4 4" />
              <Area type="monotone" dataKey="cumulativeReturnRate" stroke={GOLD} strokeWidth={2.5} fill="url(#goldFade)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

function BetTypeReturnCard() {
  const [stats, setStats] = useState<BetTypeStats[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json())
      .then((json) => setStats(json.stats))
      .finally(() => setLoading(false))
  }, [])

  const data = BET_TYPE_ORDER.filter((t) => stats.some((s) => s.betType === t)).map((t) => {
    const s = stats.find((x) => x.betType === t)!
    return { ...s, label: BET_TYPE_LABELS[t] ?? t }
  })

  return (
    <div className="card border-0 shadow-sm h-100">
      <div className="card-body">
        <h2 className="h6 fw-bold mb-3">券種別の回収率</h2>
        {loading ? (
          <div className="text-muted small text-center py-5">読み込み中...</div>
        ) : data.length === 0 ? (
          <ChartEmptyState />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="#9ca3af" />
              <YAxis tick={{ fontSize: 12 }} stroke="#9ca3af" unit="%" />
              <Tooltip formatter={(v, _name, item) => [`${v}% (${item.payload.attempts}件)`, '回収率']} />
              <ReferenceLine y={100} stroke="#9ca3af" strokeDasharray="4 4" />
              <Bar dataKey="returnRate" radius={[4, 4, 0, 0]}>
                {data.map((d) => (
                  <Cell key={d.betType} fill={d.returnRate >= 100 ? GOLD_BRIGHT : NAVY} fillOpacity={d.returnRate >= 100 ? 1 : 0.55} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

function StatsSection() {
  const [granularity, setGranularity] = useState<Granularity>('day')
  const [points, setPoints] = useState<StatsPeriodPoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/stats/timeseries?granularity=${granularity}`)
      .then((r) => r.json())
      .then((json) => setPoints(json.points))
      .finally(() => setLoading(false))
  }, [granularity])

  return (
    <>
      <div className="row g-3 mb-3">
        <div className="col-12">
          <ReturnRateTrendCard granularity={granularity} onGranularityChange={setGranularity} points={points} loading={loading} />
        </div>
      </div>
      <div className="row g-3">
        <div className="col-lg-6">
          <CumulativeReturnCard granularity={granularity} points={points} loading={loading} />
        </div>
        <div className="col-lg-6">
          <BetTypeReturnCard />
        </div>
      </div>
    </>
  )
}

function ReturnRateTrendCard({
  granularity,
  onGranularityChange,
  points,
  loading,
}: {
  granularity: Granularity
  onGranularityChange: (g: Granularity) => void
  points: StatsPeriodPoint[]
  loading: boolean
}) {
  const data = points.map((p) => ({ ...p, label: formatPeriodLabel(p.period, granularity) }))
  return (
    <div className="card border-0 shadow-sm h-100">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
          <h2 className="h6 fw-bold mb-0">回収率の推移</h2>
          <GranularityToggle value={granularity} onChange={onGranularityChange} />
        </div>
        {loading ? (
          <div className="text-muted small text-center py-5">読み込み中...</div>
        ) : data.length === 0 ? (
          <ChartEmptyState />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="#9ca3af" />
              <YAxis tick={{ fontSize: 12 }} stroke="#9ca3af" unit="%" />
              <Tooltip formatter={(v) => [`${v}%`, '回収率']} />
              <ReferenceLine y={100} stroke="#9ca3af" strokeDasharray="4 4" label={{ value: '損益分岐 100%', fontSize: 11, fill: '#9ca3af', position: 'insideTopRight' }} />
              <Line type="monotone" dataKey="returnRate" name="returnRate" stroke={NAVY} strokeWidth={2.5} dot={{ r: 3, fill: GOLD_BRIGHT, stroke: NAVY }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

function Dashboard() {
  return (
    <div className="container py-4">
      <div className="mb-4">
        <h1 className="h3 fw-bold mb-1">ダッシュボード</h1>
        <p className="text-muted mb-0">直近の予想と、これまでの回収率の推移です。</p>
      </div>

      <RecentPicksSection />

      <StatsSection />
    </div>
  )
}

export default Dashboard
