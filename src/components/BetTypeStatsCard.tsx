import { useEffect, useState } from 'react'

type BetTypeStats = {
  betType: string
  attempts: number
  hits: number
  hitRate: number
  totalStakeYen: number
  totalPayout: number
  returnRate: number
}

type StatsSummary = {
  raceCount: number
  totalStakeYen: number
  totalPayout: number
  netYen: number
  returnRate: number
  byType: BetTypeStats[]
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

type PeriodOption = 'all' | '365' | '90' | '30' | '7'
const PERIOD_LABELS: Record<PeriodOption, string> = {
  all: '全期間',
  '365': '直近1年',
  '90': '直近3ヶ月',
  '30': '直近30日',
  '7': '直近7日',
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

function BetTypeStatsCard() {
  const [period, setPeriod] = useState<PeriodOption>('all')
  const [confidenceOption, setConfidenceOption] = useState<ConfidenceOption>('all')
  const [summary, setSummary] = useState<StatsSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const params: Record<string, string> = {}
    if (period !== 'all') params.daysBack = period
    const confidenceValues = CONFIDENCE_VALUES[confidenceOption]
    if (confidenceValues.length > 0) params.confidence = confidenceValues.join(',')

    fetch(`/api/jrdb/stats?${new URLSearchParams(params).toString()}`)
      .then((r) => r.json())
      .then((json) => setSummary(json.summary))
      .finally(() => setLoading(false))
  }, [period, confidenceOption])

  const statsByType = new Map((summary?.byType ?? []).map((s) => [s.betType, s]))

  return (
    <div className="card border-0 shadow-sm mb-4">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
          <h2 className="h6 fw-bold mb-0">券種別 的中率・回収率(JRDBバックテスト)</h2>
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <select
              className="form-select form-select-sm"
              style={{ width: 'auto' }}
              value={period}
              onChange={(e) => setPeriod(e.target.value as PeriodOption)}
            >
              {(Object.keys(PERIOD_LABELS) as PeriodOption[]).map((opt) => (
                <option key={opt} value={opt}>
                  {PERIOD_LABELS[opt]}
                </option>
              ))}
            </select>
            <select
              className="form-select form-select-sm"
              style={{ width: 'auto' }}
              value={confidenceOption}
              onChange={(e) => setConfidenceOption(e.target.value as ConfidenceOption)}
              title="予想時の確信度で絞り込む"
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
          <p className="text-muted small mb-0">読み込み中... (全期間は数秒かかることがあります)</p>
        ) : !summary || summary.raceCount === 0 ? (
          <p className="text-muted small mb-0">この条件に該当する結果確定済みレースはありません。</p>
        ) : (
          <>
            <div className="d-flex flex-wrap gap-3 mb-2 small">
              <span>
                レース総数: <span className="fw-semibold">{summary.raceCount.toLocaleString()}件</span>
              </span>
              <span>
                収支合計:{' '}
                <span className={`fw-semibold ${summary.netYen >= 0 ? 'text-success' : 'text-danger'}`}>
                  {summary.netYen >= 0 ? '+' : ''}
                  {summary.netYen.toLocaleString()}円
                </span>
              </span>
              <span>
                購入額合計: <span className="fw-semibold">{summary.totalStakeYen.toLocaleString()}円</span>
              </span>
              <span>
                払戻合計: <span className="fw-semibold">{summary.totalPayout.toLocaleString()}円</span>
              </span>
            </div>
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th>券種</th>
                    <th>試行数</th>
                    <th>的中数</th>
                    <th>的中率</th>
                    <th>購入額</th>
                    <th>払戻額</th>
                    <th>回収率</th>
                  </tr>
                </thead>
                <tbody>
                  {BET_TYPE_ORDER.filter((t) => statsByType.has(t)).map((t) => {
                    const s = statsByType.get(t)!
                    return (
                      <tr key={t}>
                        <td>{BET_TYPE_LABELS[t]}</td>
                        <td>{s.attempts.toLocaleString()}</td>
                        <td>{s.hits.toLocaleString()}</td>
                        <td className="fw-semibold">{s.hitRate}%</td>
                        <td className="text-muted">{s.totalStakeYen.toLocaleString()}円</td>
                        <td className="text-muted">{s.totalPayout.toLocaleString()}円</td>
                        <td className={s.returnRate >= 100 ? 'text-success fw-semibold' : 'fw-semibold'}>{s.returnRate}%</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="text-muted small mb-0 mt-2">
          <i className="bi bi-info-circle me-1" />
          JRDBのダウンロード済みアーカイブ全体に対し、総合指数から算出した推奨買い目(1レース3,000円を券種均等配分・確率比例で100円単位配分)を機械的に当てはめて実際の配当と突き合わせた、大規模バックテストの結果です。
        </p>
      </div>
    </div>
  )
}

export default BetTypeStatsCard
