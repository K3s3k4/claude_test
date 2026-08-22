import { useEffect, useState } from 'react'

type RaceHistoryRow = {
  raceId: string
  raceName: string
  course: string
  predictedAt: string
  confirmedAt: string | null
}

type BetTypeStats = {
  betType: string
  attempts: number
  hits: number
  hitRate: number
  totalPayout: number
  returnRate: number
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

function formatDateTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function History() {
  const [races, setRaces] = useState<RaceHistoryRow[]>([])
  const [stats, setStats] = useState<BetTypeStats[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchingResultFor, setFetchingResultFor] = useState<string | null>(null)

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const [historyRes, statsRes] = await Promise.all([fetch('/api/history'), fetch('/api/stats')])
      const historyJson = await historyRes.json()
      const statsJson = await statsRes.json()
      setRaces(historyJson.races)
      setStats(statsJson.stats)
    } catch {
      setError('履歴の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
  }, [])

  async function handleFetchResult(raceId: string) {
    setFetchingResultFor(raceId)
    setError(null)
    try {
      const res = await fetch(`/api/results/${raceId}`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || '結果の取得に失敗しました')
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : '結果の取得に失敗しました')
    } finally {
      setFetchingResultFor(null)
    }
  }

  const statsByType = new Map(stats.map((s) => [s.betType, s]))

  return (
    <div className="container py-4">
      <div className="mb-4">
        <h1 className="h3 fw-bold mb-1">予想履歴</h1>
        <p className="text-muted mb-0">/predict で予想したレースは自動的に記録されます。レース確定後に結果を取得すると的中率・回収率に反映されます。</p>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <h2 className="h6 fw-bold mb-3">券種別 的中率・回収率</h2>
          {stats.length === 0 ? (
            <p className="text-muted small mb-0">結果確定済みのレースがまだありません。</p>
          ) : (
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th>券種</th>
                    <th>試行数</th>
                    <th>的中数</th>
                    <th>的中率</th>
                    <th>回収率(100円/点換算)</th>
                  </tr>
                </thead>
                <tbody>
                  {BET_TYPE_ORDER.filter((t) => statsByType.has(t)).map((t) => {
                    const s = statsByType.get(t)!
                    return (
                      <tr key={t}>
                        <td>{BET_TYPE_LABELS[t]}</td>
                        <td>{s.attempts}</td>
                        <td>{s.hits}</td>
                        <td className="fw-semibold">{s.hitRate}%</td>
                        <td className={s.returnRate >= 100 ? 'text-success fw-semibold' : ''}>{s.returnRate}%</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-muted small mb-0 mt-2">
            <i className="bi bi-info-circle me-1" />
            試行数は推奨買い目1組(1点)ごとにカウントしています。回収率は1点あたり100円で購入した想定の参考値です。
          </p>
        </div>
      </div>

      <div className="card border-0 shadow-sm">
        <div className="card-body">
          <h2 className="h6 fw-bold mb-3">予想したレース一覧</h2>
          {loading ? (
            <p className="text-muted small mb-0">読み込み中...</p>
          ) : races.length === 0 ? (
            <p className="text-muted small mb-0">まだ予想履歴がありません。/predict でレースを予想すると記録されます。</p>
          ) : (
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th>レース</th>
                    <th>予想日時</th>
                    <th>状態</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {races.map((r) => (
                    <tr key={r.raceId}>
                      <td>
                        <div className="fw-semibold">{r.raceName || r.raceId}</div>
                        <div className="text-muted small">{r.course}</div>
                      </td>
                      <td className="text-muted small">{formatDateTime(r.predictedAt)}</td>
                      <td>
                        {r.confirmedAt ? (
                          <span className="badge bg-success-subtle text-success-emphasis">確定済み</span>
                        ) : (
                          <span className="badge bg-secondary-subtle text-secondary-emphasis">未確定</span>
                        )}
                      </td>
                      <td>
                        {!r.confirmedAt && (
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-primary"
                            disabled={fetchingResultFor === r.raceId}
                            onClick={() => handleFetchResult(r.raceId)}
                          >
                            {fetchingResultFor === r.raceId ? '取得中...' : '結果を取得'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
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
