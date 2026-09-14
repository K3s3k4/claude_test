import { Fragment, useEffect, useRef, useState } from 'react'

type RaceHistoryRow = {
  raceId: string
  raceName: string
  course: string
  venue: string
  raceDate: string
  predictedAt: string
  confirmedAt: string | null
}

type RaceDetailFinisher = { umaban: number; name: string; finishPosition: number | null }
type RaceDetailBet = {
  umabanCombo: string
  names: string
  probability: number
  hit: boolean | null
  payout: number | null
}
type RaceDetail = {
  raceId: string
  raceName: string
  course: string
  venue: string
  raceDate: string
  predictedAt: string
  confirmedAt: string | null
  finishOrder: RaceDetailFinisher[]
  betsByType: Record<string, RaceDetailBet[]>
  totalAttempts: number
  totalPayout: number
  returnRate: number | null
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

function formatRaceDate(dateStr: string) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

type BackfillJob = {
  status: 'discovering' | 'running' | 'done' | 'error'
  totalDays: number
  daysScanned: number
  racesFound: number
  racesCompleted: number
  racesSkipped: number
  racesFailed: number
  currentRaceId: string | null
  error?: string
}

function BackfillSection({ onDone }: { onDone: () => void }) {
  const [job, setJob] = useState<BackfillJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  async function handleFetch() {
    setError(null)
    setJob(null)
    try {
      const res = await fetch('/api/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daysBack: 14 }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || '開始に失敗しました')

      pollRef.current = setInterval(async () => {
        const statusRes = await fetch(`/api/backfill/${json.jobId}`)
        const statusJson: BackfillJob = await statusRes.json()
        setJob(statusJson)
        if (statusJson.status === 'done' || statusJson.status === 'error') {
          if (pollRef.current) clearInterval(pollRef.current)
          if (statusJson.status === 'done') onDone()
        }
      }, 4000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '開始に失敗しました')
    }
  }

  const isRunning = job && job.status !== 'done' && job.status !== 'error'

  return (
    <div className="card border-0 shadow-sm mb-4">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-center mb-2">
          <h2 className="h6 fw-bold mb-0">過去2週間のレース情報・結果・分析結果を取得</h2>
          <button type="button" className="btn btn-sm btn-primary" disabled={!!isRunning} onClick={handleFetch}>
            {isRunning ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" role="status" />
                取得中...
              </>
            ) : (
              '取得する'
            )}
          </button>
        </div>
        <p className="text-muted small mb-2">
          過去14日分のレースを検出し、予想・結果照合をまとめて実行します。件数によっては数十分〜1時間以上かかる場合があります。
          すでに結果確定済みのレースは自動的にスキップされるため、途中で中断しても再実行できます。
        </p>

        {error && <div className="alert alert-danger py-2 small mb-2">{error}</div>}
        {job?.status === 'error' && (
          <div className="alert alert-danger py-2 small mb-2">中断しました: {job.error}</div>
        )}
        {job && (
          <div className="small text-muted">
            {job.status === 'discovering' && '開催日を探索中...'}
            {job.status === 'running' &&
              `処理中: ${job.racesFound}件中 完了${job.racesCompleted} / スキップ${job.racesSkipped} / 失敗${job.racesFailed}（現在: ${job.currentRaceId}）`}
            {job.status === 'done' &&
              `完了: ${job.racesFound}件中 完了${job.racesCompleted} / スキップ${job.racesSkipped} / 失敗${job.racesFailed}`}
          </div>
        )}
      </div>
    </div>
  )
}

function RaceDetailPanel({ detail }: { detail: RaceDetail }) {
  return (
    <div className="p-3 bg-light rounded">
      <div className="d-flex align-items-center gap-2 mb-3 flex-wrap">
        <span className="fw-semibold small">このレースの回収率:</span>
        {detail.returnRate == null ? (
          <span className="badge bg-secondary-subtle text-secondary-emphasis">未確定</span>
        ) : (
          <span className={`badge ${detail.returnRate >= 100 ? 'bg-success' : 'bg-danger'}`}>{detail.returnRate}%</span>
        )}
        {detail.confirmedAt && (
          <span className="text-muted small">(買い目 {detail.totalAttempts}点 ・ 払戻合計 {detail.totalPayout}円)</span>
        )}
      </div>

      {detail.finishOrder.length > 0 && (
        <div className="mb-3">
          <div className="fw-semibold small mb-1">実際の着順</div>
          <div className="d-flex flex-wrap gap-2">
            {detail.finishOrder.slice(0, 5).map((f) => (
              <span key={f.umaban} className="badge bg-white text-dark border fw-normal">
                {f.finishPosition}着: {f.name}({f.umaban})
              </span>
            ))}
          </div>
        </div>
      )}

      {Object.keys(detail.betsByType).length === 0 ? (
        <p className="text-muted small mb-0">このレースの買い目データはありません。</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm table-borderless align-middle mb-0 bg-white">
            <thead>
              <tr>
                <th>券種</th>
                <th>買い目</th>
                <th>予想確率</th>
                <th>結果</th>
                <th>払戻</th>
              </tr>
            </thead>
            <tbody>
              {BET_TYPE_ORDER.filter((t) => detail.betsByType[t]?.length).map((t) =>
                detail.betsByType[t].map((b) => (
                  <tr key={`${t}-${b.umabanCombo}`}>
                    <td className="text-muted small">{BET_TYPE_LABELS[t]}</td>
                    <td className="small">
                      {b.umabanCombo} <span className="text-muted">({b.names})</span>
                    </td>
                    <td className="small">{(b.probability * 100).toFixed(1)}%</td>
                    <td>
                      {b.hit == null ? (
                        <span className="text-muted small">-</span>
                      ) : b.hit ? (
                        <span className="badge bg-success">的中</span>
                      ) : (
                        <span className="badge bg-secondary-subtle text-secondary-emphasis">不的中</span>
                      )}
                    </td>
                    <td className="small">{b.payout ? `${b.payout}円` : '-'}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function History() {
  const [races, setRaces] = useState<RaceHistoryRow[]>([])
  const [stats, setStats] = useState<BetTypeStats[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchingResultFor, setFetchingResultFor] = useState<string | null>(null)
  const [expandedRaceId, setExpandedRaceId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, RaceDetail>>({})
  const [detailLoading, setDetailLoading] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

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

  async function handleRowClick(raceId: string) {
    if (expandedRaceId === raceId) {
      setExpandedRaceId(null)
      return
    }
    setExpandedRaceId(raceId)
    setDetailError(null)
    if (details[raceId]) return
    setDetailLoading(raceId)
    try {
      const res = await fetch(`/api/history/${raceId}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || '詳細の取得に失敗しました')
      setDetails((prev) => ({ ...prev, [raceId]: json.detail }))
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '詳細の取得に失敗しました')
    } finally {
      setDetailLoading(null)
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

      <BackfillSection onDone={loadAll} />

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
                    <th />
                    <th>レース</th>
                    <th>開催日・会場</th>
                    <th>予想日時</th>
                    <th>状態</th>
                    <th>回収率</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {races.map((r) => {
                    const isExpanded = expandedRaceId === r.raceId
                    const detail = details[r.raceId]
                    return (
                      <Fragment key={r.raceId}>
                        <tr
                          role="button"
                          onClick={() => handleRowClick(r.raceId)}
                          className={isExpanded ? 'table-active' : ''}
                        >
                          <td className="text-muted">
                            <i className={`bi ${isExpanded ? 'bi-chevron-down' : 'bi-chevron-right'}`} />
                          </td>
                          <td>
                            <div className="fw-semibold">{r.raceName || r.raceId}</div>
                            <div className="text-muted small">{r.course}</div>
                          </td>
                          <td className="text-muted small">
                            {formatRaceDate(r.raceDate)}
                            {r.venue && ` ${r.venue}`}
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
                            {detail?.returnRate != null ? (
                              <span className={`fw-semibold ${detail.returnRate >= 100 ? 'text-success' : 'text-danger'}`}>
                                {detail.returnRate}%
                              </span>
                            ) : (
                              <span className="text-muted small">-</span>
                            )}
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
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
                        {isExpanded && (
                          <tr>
                            <td colSpan={7} className="p-0">
                              {detailLoading === r.raceId ? (
                                <div className="p-3 text-muted small">読み込み中...</div>
                              ) : detailError ? (
                                <div className="p-3 text-danger small">{detailError}</div>
                              ) : detail ? (
                                <RaceDetailPanel detail={detail} />
                              ) : null}
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
