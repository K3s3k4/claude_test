import { useEffect, useRef, useState } from 'react'

type Stat = {
  label: string
  value: string
  change: string
  trend: 'up' | 'down'
  icon: string
}

type RecentPickCombo = { umabanCombo: string; names: string; probability: number }
type RecentPick = {
  raceId: string
  raceName: string
  course: string
  predictedAt: string
  confidence: string | null
  probabilityGap: number | null
  betsByType: Record<string, RecentPickCombo[]>
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
            {picks.map((p) => (
              <div className="col-md-6" key={p.raceId}>
                <div className="border rounded p-3 h-100">
                  <div className="d-flex align-items-center gap-2 mb-2">
                    <span className="fw-semibold small">{p.raceName || p.raceId}</span>
                    {p.confidence && (
                      <span className={`badge ${confidenceBadgeClass(p.confidence)}`}>{p.confidence}</span>
                    )}
                  </div>
                  <div className="text-muted small mb-2">{p.course}</div>
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
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const STATS: Stat[] = [
  { label: '総ユーザー数', value: '12,483', change: '+8.2%', trend: 'up', icon: 'bi-people-fill' },
  { label: '売上', value: '¥2,340,000', change: '+12.5%', trend: 'up', icon: 'bi-graph-up-arrow' },
  { label: '注文数', value: '1,024', change: '-3.1%', trend: 'down', icon: 'bi-bag-check-fill' },
  { label: 'コンバージョン率', value: '3.8%', change: '+0.4%', trend: 'up', icon: 'bi-bullseye' },
]

const RECENT_ACTIVITY = [
  { name: '佐藤 花子', action: '新規登録', time: '2分前' },
  { name: '田中 太郎', action: '注文を完了', time: '18分前' },
  { name: '鈴木 一郎', action: 'プランをアップグレード', time: '1時間前' },
  { name: '高橋 陽子', action: 'サポートに問い合わせ', time: '3時間前' },
]

function Dashboard() {
  return (
    <div className="container py-4">
      <div className="mb-4">
        <h1 className="h3 fw-bold mb-1">ダッシュボード</h1>
        <p className="text-muted mb-0">ようこそ。サイトの概況はこちらです。</p>
      </div>

      <RecentPicksSection />

      <div className="row g-3 mb-4">
        {STATS.map((stat) => (
          <div className="col-6 col-lg-3" key={stat.label}>
            <div className="card h-100 border-0 shadow-sm">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-start mb-2">
                  <span className="text-muted small">{stat.label}</span>
                  <span className="rounded-circle bg-primary bg-opacity-10 text-primary d-inline-flex align-items-center justify-content-center" style={{ width: 36, height: 36 }}>
                    <i className={`bi ${stat.icon}`} />
                  </span>
                </div>
                <div className="fs-4 fw-bold">{stat.value}</div>
                <div className={`small ${stat.trend === 'up' ? 'text-success' : 'text-danger'}`}>
                  <i className={`bi ${stat.trend === 'up' ? 'bi-arrow-up-short' : 'bi-arrow-down-short'}`} />
                  {stat.change}
                  <span className="text-muted"> 先月比</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="row g-3">
        <div className="col-lg-8">
          <div className="card border-0 shadow-sm h-100">
            <div className="card-body">
              <h2 className="h6 fw-bold mb-3">概要</h2>
              <div className="d-flex align-items-center justify-content-center text-muted bg-light rounded" style={{ height: 260 }}>
                グラフ表示エリア（後で実装）
              </div>
            </div>
          </div>
        </div>
        <div className="col-lg-4">
          <div className="card border-0 shadow-sm h-100">
            <div className="card-body">
              <h2 className="h6 fw-bold mb-3">最近のアクティビティ</h2>
              <ul className="list-group list-group-flush">
                {RECENT_ACTIVITY.map((item) => (
                  <li className="list-group-item px-0 d-flex justify-content-between align-items-center" key={item.name + item.time}>
                    <div>
                      <div className="fw-semibold small">{item.name}</div>
                      <div className="text-muted small">{item.action}</div>
                    </div>
                    <span className="text-muted small">{item.time}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Dashboard
