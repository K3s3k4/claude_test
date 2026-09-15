import { useEffect, useRef, useState } from 'react'
import BetTypeStatsCard from './BetTypeStatsCard'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts'

type Pick = { umaban: number; name: string }
type PricedCombo = { picks: Pick[]; probability: number; stakeYen: number }
type PricedSingle = { pick: Pick; stakeYen: number }
type JrdbBetSuggestions = {
  boxSize: number
  tansho: (PricedSingle & { winProbability: number })[]
  fukusho: (PricedSingle & { placeProbability: number })[]
  umaren: PricedCombo[]
  wide: PricedCombo[]
  umatan: PricedCombo[]
  sanrenpuku: PricedCombo[]
  sanrentan: PricedCombo[]
  totalStakeYen: number
}
type RecentPick = {
  raceKey: string
  raceDate: string
  venueCode: string
  venueName: string
  raceNumber: number
  raceName: string | null
  gradeLabel: string | null
  confidence: '堅い' | 'やや堅い' | '混戦'
  confidenceScore: number
  topPickSummary: string
  completed: boolean
  totalStakeYen: number | null
  totalPayoutYen: number | null
  returnRate: number | null
  bets: JrdbBetSuggestions | null
}

const COMBO_TYPE_LABELS: Record<string, string> = {
  umaren: '馬連',
  wide: 'ワイド',
  umatan: '馬単',
  sanrenpuku: '三連複',
  sanrentan: '三連単',
}
const COMBO_TYPE_ORDER = ['umaren', 'wide', 'umatan', 'sanrenpuku', 'sanrentan']
const ORDERED_COMBO_TYPES = new Set(['umatan', 'sanrentan'])

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

function confidenceBadgeClass(confidence: string | null) {
  if (confidence === '堅い') return 'bg-success'
  if (confidence === 'やや堅い') return 'bg-primary'
  if (confidence === '混戦') return 'bg-danger'
  return 'bg-secondary'
}

type JrdbSyncJob = {
  status: 'running' | 'done' | 'error'
  totalChecks: number
  checked: number
  downloaded: number
  skippedNoData: number
  failed: number
  error?: string
}

function JrdbSyncSection() {
  const [job, setJob] = useState<JrdbSyncJob | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current)
    },
    [],
  )

  async function handleSync() {
    const res = await fetch('/api/jrdb/sync', { method: 'POST' })
    const json = await res.json()
    pollRef.current = setInterval(async () => {
      const statusRes = await fetch(`/api/jrdb/sync/${json.jobId}`)
      const statusJson: JrdbSyncJob = await statusRes.json()
      setJob(statusJson)
      if (statusJson.status !== 'running' && pollRef.current) {
        clearInterval(pollRef.current)
      }
    }, 2000)
  }

  const isRunning = job?.status === 'running'

  return (
    <div className="card border-0 shadow-sm mb-4">
      <div className="card-body d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div>
          <h2 className="h6 fw-bold mb-1">JRDBデータの更新</h2>
          <p className="text-muted small mb-0">
            過去14日・未来10日分の未取得データを確認して取得します(週1回は自動でも実行されます)。
          </p>
          {job && (
            <p className="small mb-0 mt-1">
              {job.status === 'running' && (
                <>
                  <span className="spinner-border spinner-border-sm me-2" role="status" />
                  確認中: {job.checked}/{job.totalChecks}(取得{job.downloaded})
                </>
              )}
              {job.status === 'done' && `完了: 取得${job.downloaded} / データなし${job.skippedNoData} / 失敗${job.failed}`}
              {job.status === 'error' && <span className="text-danger">エラー: {job.error}</span>}
            </p>
          )}
        </div>
        <button type="button" className="btn btn-sm btn-outline-primary" disabled={isRunning} onClick={handleSync}>
          {isRunning ? '更新中...' : '未取得分を取得'}
        </button>
      </div>
    </div>
  )
}

function RecentPicksSection() {
  const [picks, setPicks] = useState<RecentPick[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetch('/api/jrdb/recent-picks?limit=4')
      .then((r) => r.json())
      .then((json) => setPicks(json.picks))
      .catch(() => setError('直近の自信がある買い目の取得に失敗しました'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="card border-0 shadow-sm mb-4">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h2 className="h6 fw-bold mb-0">直近の自信がある買い目(JRDB)</h2>
        </div>

        {error && <div className="alert alert-danger py-2 small">{error}</div>}

        {loading ? (
          <p className="text-muted small mb-0">読み込み中...</p>
        ) : picks.length === 0 ? (
          <p className="text-muted small mb-0">JRDBデータがまだありません。データのダウンロードをお待ちください。</p>
        ) : (
          <div className="row g-3">
            {picks.map((p) => {
              const isExpanded = expandedKey === p.raceKey
              return (
                <div className="col-md-6" key={p.raceKey}>
                  <div
                    className="border rounded p-3 h-100"
                    role="button"
                    onClick={() => setExpandedKey(isExpanded ? null : p.raceKey)}
                  >
                    <div className="d-flex align-items-center gap-2 mb-1 flex-wrap">
                      <span className="fw-semibold small">
                        {p.venueName}
                        {p.raceNumber}R
                        {p.raceName && ` ${p.raceName}`}
                        {p.gradeLabel && ` (${p.gradeLabel})`}
                      </span>
                      <span className={`badge ${confidenceBadgeClass(p.confidence)}`}>{p.confidence}</span>
                      <span className={`small fw-bold ${confidenceScoreClass(p.confidenceScore)}`}>
                        確度 {p.confidenceScore}
                        <span className="text-muted fw-normal">/100</span>
                      </span>
                      <i className={`bi ${isExpanded ? 'bi-chevron-up' : 'bi-chevron-down'} text-muted ms-auto`} />
                    </div>
                    <div className="text-muted small mb-2">
                      {formatRaceDate(p.raceDate)}
                      {p.completed && p.returnRate != null && (
                        <span className="ms-2">
                          確定済み・回収率{' '}
                          <span className={p.returnRate >= 100 ? 'text-success fw-semibold' : 'text-danger fw-semibold'}>
                            {p.returnRate}%
                          </span>
                        </span>
                      )}
                    </div>
                    {p.bets && (
                      <>
                        <div className="small mb-1">
                          <span className="text-muted me-1">単勝:</span>
                          {p.bets.tansho.map((t) => (
                            <span key={t.pick.umaban} className="badge bg-light text-dark border me-1 fw-normal">
                              {t.pick.umaban} {t.pick.name} ({(t.winProbability * 100).toFixed(1)}%)
                              {t.stakeYen > 0 && <span className="text-muted"> ・ {t.stakeYen.toLocaleString()}円</span>}
                            </span>
                          ))}
                        </div>
                        {COMBO_TYPE_ORDER.filter((t) => p.bets![t as keyof JrdbBetSuggestions] as PricedCombo[]).map((t) => {
                          const combos = p.bets![t as keyof JrdbBetSuggestions] as PricedCombo[]
                          if (!combos?.length) return null
                          const sep = ORDERED_COMBO_TYPES.has(t) ? '→' : '-'
                          return (
                            <div key={t} className="small mb-1">
                              <span className="text-muted me-1">{COMBO_TYPE_LABELS[t]}:</span>
                              {combos.slice(0, 2).map((c, i) => (
                                <span key={i} className="badge bg-light text-dark border me-1 fw-normal">
                                  {c.picks.map((p2) => p2.umaban).join(sep)} ({(c.probability * 100).toFixed(1)}%)
                                  {c.stakeYen > 0 && <span className="text-muted"> ・ {c.stakeYen.toLocaleString()}円</span>}
                                </span>
                              ))}
                            </div>
                          )
                        })}
                      </>
                    )}

                    {isExpanded && (
                      <div className="mt-2 pt-2 border-top" onClick={(e) => e.stopPropagation()}>
                        <p className="small mb-0">{p.topPickSummary}</p>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {picks.length > 0 && (
          <p className="text-muted small mb-0 mt-2">
            <i className="bi bi-info-circle me-1" />
            JRDBの総合指数をもとに算出した参考値です。金額は1レース3,000円を券種に均等配分し、券種内は推定確率に比例して100円単位で配分した想定購入額です。
          </p>
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
  totalStakeYen: number
  totalPayout: number
  returnRate: number
  cumulativeReturnRate: number
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

function StatsSection() {
  const [granularity, setGranularity] = useState<Granularity>('day')
  const [points, setPoints] = useState<StatsPeriodPoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/jrdb/stats/timeseries?granularity=${granularity}`)
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
        <div className="col-12">
          <CumulativeReturnCard granularity={granularity} points={points} loading={loading} />
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

      <JrdbSyncSection />

      <RecentPicksSection />

      <BetTypeStatsCard />

      <StatsSection />
    </div>
  )
}

export default Dashboard
