import { Fragment, useEffect, useState } from 'react'
import BetTypeStatsCard from './BetTypeStatsCard'

type Confidence = '堅い' | 'やや堅い' | '混戦'

type JrdbRaceRecord = {
  raceKey: string
  raceDate: string
  venueCode: string
  venueName: string
  raceNumber: number
  raceName: string | null
  gradeLabel: string | null
  confidence: Confidence
  confidenceScore: number
  topPickSummary: string
  completed: boolean
  totalStakeYen: number | null
  totalPayoutYen: number | null
  returnRate: number | null
}

type Pick = { umaban: number; name: string }
type ActualBet = { picks: Pick[]; stakeYen: number; hit: boolean; payoutYen: number }
type ActualReturn = {
  tansho: ActualBet[]
  fukusho: ActualBet[]
  umaren: ActualBet[]
  wide: ActualBet[]
  umatan: ActualBet[]
  sanrenpuku: ActualBet[]
  sanrentan: ActualBet[]
  totalStakeYen: number
  totalPayoutYen: number
  returnRate: number | null
  note: string | null
}
type FinishHorse = { umaban: number; horseName: string; finishPosition: number | null }
type RaceDetailResponse = {
  result: { finishOrder: FinishHorse[]; actualReturn: ActualReturn | null } | null
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

function formatRaceDate(dateStr: string) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

function confidenceBadgeClass(label: Confidence) {
  if (label === '堅い') return 'bg-success'
  if (label === 'やや堅い') return 'bg-primary'
  return 'bg-danger'
}

type DaysBackOption = '7' | '14' | '21' | '30' | '90'
const DAYS_BACK_LABELS: Record<DaysBackOption, string> = {
  '7': '直近1週間',
  '14': '直近2週間',
  '21': '直近3週間',
  '30': '直近1ヶ月',
  '90': '直近3ヶ月',
}

type ConfidenceOption = 'all' | 'strict' | 'strictPlus'
const CONFIDENCE_VALUES: Record<ConfidenceOption, string[]> = {
  all: [],
  strict: ['堅い'],
  strictPlus: ['堅い', 'やや堅い'],
}
const CONFIDENCE_LABELS: Record<ConfidenceOption, string> = {
  all: 'すべてのレース',
  strict: '「堅い」のみ',
  strictPlus: '「堅い」+「やや堅い」',
}

function RaceDetailPanel({ record }: { record: JrdbRaceRecord }) {
  const [detail, setDetail] = useState<RaceDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/jrdb/race?date=${record.raceDate}&venue=${encodeURIComponent(record.venueName)}&raceNumber=${record.raceNumber}`)
      .then((r) => r.json())
      .then((json) => setDetail(json))
      .catch(() => setError('詳細の取得に失敗しました'))
      .finally(() => setLoading(false))
  }, [record.raceDate, record.venueName, record.raceNumber])

  if (loading) return <div className="p-3 text-muted small">読み込み中...</div>
  if (error) return <div className="p-3 text-danger small">{error}</div>

  const actualReturn = detail?.result?.actualReturn
  const finishOrder = detail?.result?.finishOrder

  return (
    <div className="p-3 bg-light rounded">
      <p className="small mb-3">{record.topPickSummary}</p>

      {finishOrder && finishOrder.length > 0 && (
        <div className="mb-3">
          <div className="fw-semibold small mb-1">実際の着順</div>
          <div className="d-flex flex-wrap gap-2">
            {finishOrder.slice(0, 5).map((f) => (
              <span key={f.umaban} className="badge bg-white text-dark border fw-normal">
                {f.finishPosition}着: {f.horseName}({f.umaban})
              </span>
            ))}
          </div>
        </div>
      )}

      {actualReturn ? (
        <>
          <div className="d-flex flex-wrap gap-3 mb-2 small">
            <span>
              購入額: <span className="fw-semibold">{actualReturn.totalStakeYen.toLocaleString()}円</span>
            </span>
            <span>
              払戻: <span className="fw-semibold">{actualReturn.totalPayoutYen.toLocaleString()}円</span>
            </span>
            <span>
              回収率:{' '}
              <span className={`fw-semibold ${(actualReturn.returnRate ?? 0) >= 100 ? 'text-success' : 'text-danger'}`}>
                {actualReturn.returnRate != null ? `${actualReturn.returnRate}%` : '-'}
              </span>
            </span>
          </div>
          {BET_TYPE_ORDER.filter((t) => actualReturn[t as keyof ActualReturn] && (actualReturn[t as keyof ActualReturn] as ActualBet[]).length > 0).map(
            (t) => (
              <div key={t} className="d-flex align-items-center flex-wrap gap-1 mb-1">
                <span className="text-muted small me-1">{BET_TYPE_LABELS[t]}:</span>
                {(actualReturn[t as keyof ActualReturn] as ActualBet[]).map((b, i) => (
                  <span
                    key={i}
                    className={`badge fw-normal border ${b.hit ? 'bg-success-subtle text-success-emphasis' : 'bg-light text-muted'}`}
                  >
                    {b.picks.map((p) => p.umaban).join('-')} {b.hit ? `的中 ${b.payoutYen.toLocaleString()}円` : '不的中'}
                  </span>
                ))}
              </div>
            ),
          )}
          {actualReturn.note && (
            <p className="text-muted small mb-0 mt-2">
              <i className="bi bi-info-circle me-1" />
              {actualReturn.note}
            </p>
          )}
        </>
      ) : (
        <p className="text-muted small mb-0">まだ結果が確定していません。</p>
      )}
    </div>
  )
}

function History() {
  const [daysBack, setDaysBack] = useState<DaysBackOption>('21')
  const [confidenceOption, setConfidenceOption] = useState<ConfidenceOption>('all')
  const [races, setRaces] = useState<JrdbRaceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const params: Record<string, string> = { daysBack }
    const confidenceValues = CONFIDENCE_VALUES[confidenceOption]
    if (confidenceValues.length > 0) params.confidence = confidenceValues.join(',')

    fetch(`/api/jrdb/races/search?${new URLSearchParams(params).toString()}`)
      .then((r) => r.json())
      .then((json) => setRaces(json.races))
      .catch(() => setError('レース一覧の取得に失敗しました'))
      .finally(() => setLoading(false))
  }, [daysBack, confidenceOption])

  return (
    <div className="container py-4">
      <div className="mb-4">
        <h1 className="h3 fw-bold mb-1">予測履歴(JRDB)</h1>
        <p className="text-muted mb-0">
          JRDBアーカイブから、総合指数ベースの推奨買い目を機械的に算出し、確定済みレースは実際の配当と突き合わせています。
        </p>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      <BetTypeStatsCard />

      <div className="card border-0 shadow-sm">
        <div className="card-body">
          <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
            <h2 className="h6 fw-bold mb-0">予測したレース一覧</h2>
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <select
                className="form-select form-select-sm"
                style={{ width: 'auto' }}
                value={daysBack}
                onChange={(e) => setDaysBack(e.target.value as DaysBackOption)}
              >
                {(Object.keys(DAYS_BACK_LABELS) as DaysBackOption[]).map((opt) => (
                  <option key={opt} value={opt}>
                    {DAYS_BACK_LABELS[opt]}
                  </option>
                ))}
              </select>
              <select
                className="form-select form-select-sm"
                style={{ width: 'auto' }}
                value={confidenceOption}
                onChange={(e) => setConfidenceOption(e.target.value as ConfidenceOption)}
              >
                {(Object.keys(CONFIDENCE_LABELS) as ConfidenceOption[]).map((opt) => (
                  <option key={opt} value={opt}>
                    {CONFIDENCE_LABELS[opt]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {loading ? (
            <p className="text-muted small mb-0">読み込み中...</p>
          ) : races.length === 0 ? (
            <p className="text-muted small mb-0">この条件に該当するレースがありません。</p>
          ) : (
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th />
                    <th>レース</th>
                    <th>開催日</th>
                    <th>確信度</th>
                    <th>状態</th>
                    <th>回収率</th>
                  </tr>
                </thead>
                <tbody>
                  {races.map((r) => {
                    const isExpanded = expandedKey === r.raceKey
                    return (
                      <Fragment key={r.raceKey}>
                        <tr role="button" onClick={() => setExpandedKey(isExpanded ? null : r.raceKey)} className={isExpanded ? 'table-active' : ''}>
                          <td className="text-muted">
                            <i className={`bi ${isExpanded ? 'bi-chevron-down' : 'bi-chevron-right'}`} />
                          </td>
                          <td>
                            <div className="fw-semibold">
                              {r.venueName}
                              {r.raceNumber}R
                              {r.raceName && ` ${r.raceName}`}
                              {r.gradeLabel && ` (${r.gradeLabel})`}
                            </div>
                          </td>
                          <td className="text-muted small">{formatRaceDate(r.raceDate)}</td>
                          <td>
                            <span className={`badge ${confidenceBadgeClass(r.confidence)}`}>{r.confidence}</span>
                          </td>
                          <td>
                            {r.completed ? (
                              <span className="badge bg-success-subtle text-success-emphasis">確定済み</span>
                            ) : (
                              <span className="badge bg-secondary-subtle text-secondary-emphasis">未確定</span>
                            )}
                          </td>
                          <td>
                            {r.returnRate != null ? (
                              <span className={`fw-semibold ${r.returnRate >= 100 ? 'text-success' : 'text-danger'}`}>{r.returnRate}%</span>
                            ) : (
                              <span className="text-muted small">-</span>
                            )}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={6} className="p-0">
                              <RaceDetailPanel record={r} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default History
