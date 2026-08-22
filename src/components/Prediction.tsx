import { Fragment, useState, type FormEvent } from 'react'

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

type RaceCardHorse = {
  horseId: string
  waku: number
  umaban: number
  name: string
  sexAge: string
  weightCarried: number
  jockey: string
  trainer: string
  horseWeight: number | null
  horseWeightDiff: number | null
  odds: number | null
  popularity: number | null
}

type Pedigree = {
  sire: string
  dam: string
  sireSire: string
  sireDam: string
  damSire: string
  damDam: string
  sireSireSire: string
  sireSireDam: string
  sireDamSire: string
  sireDamDam: string
  damSireSire: string
  damSireDam: string
  damDamSire: string
  damDamDam: string
}

type RunningStyle = '逃げ' | '先行' | '差し' | '追込' | '不明'

type HorsePrediction = {
  horse: RaceCardHorse
  pedigree: Pedigree
  runningStyle: RunningStyle
  score: number
  breakdown: PredictionBreakdown
  rank: number
}

type RaceCard = {
  raceId: string
  raceName: string
  course: string
  distance: number
  surface: 'turf' | 'dirt' | 'unknown'
  trackCondition: string
  horses: RaceCardHorse[]
}

type ApiResponse = {
  race: RaceCard
  predictions: HorsePrediction[]
}

const BREAKDOWN_LABELS: Record<keyof PredictionBreakdown, string> = {
  recentForm: '近走成績',
  distanceAptitude: '距離適性',
  surfaceAptitude: '馬場適性',
  trackConditionAptitude: '馬場状態適性',
  classAdequacy: 'クラス適性',
  jockeyContinuity: '騎手相性',
  condition: 'コンディション',
  pedigree: '血統',
  market: '市場評価',
}

function extractRaceId(input: string): string | null {
  const trimmed = input.trim()
  if (/^\d{8,12}$/.test(trimmed)) return trimmed
  const match = trimmed.match(/race_id=(\d{8,12})/)
  return match ? match[1] : null
}

function rankBadgeClass(rank: number) {
  if (rank === 1) return 'bg-warning text-dark'
  if (rank === 2) return 'bg-secondary'
  if (rank === 3) return 'bg-secondary bg-opacity-50'
  return 'bg-light text-dark border'
}

function Prediction() {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const raceId = extractRaceId(input)
    if (!raceId) {
      setError('race_id を認識できませんでした。netkeibaのレースURL、または12桁のrace_idを入力してください。')
      return
    }

    setLoading(true)
    setError(null)
    setData(null)
    try {
      const res = await fetch(`/api/predict/${raceId}`)
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json.error || '取得に失敗しました')
      }
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : '取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="container py-4">
      <div className="mb-4">
        <h1 className="h3 fw-bold mb-1">競馬予想</h1>
        <p className="text-muted mb-0">
          netkeibaのレースID（またはレースURL）を入力すると、血統・過去実績をもとにスコアリングします。
        </p>
      </div>

      <form className="card border-0 shadow-sm mb-4" onSubmit={handleSubmit}>
        <div className="card-body">
          <label className="form-label small text-muted" htmlFor="race-input">
            race_id / netkeiba レースURL
          </label>
          <div className="d-flex gap-2">
            <input
              id="race-input"
              type="text"
              className="form-control"
              placeholder="例: 202601020107 または https://race.netkeiba.com/race/shutuba.html?race_id=202601020107"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button type="submit" className="btn btn-primary text-nowrap" disabled={loading}>
              {loading ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2" role="status" />
                  取得中...
                </>
              ) : (
                '予想する'
              )}
            </button>
          </div>
          {loading && (
            <div className="form-text">出走馬ごとに過去成績・血統を順番に取得しています。少し時間がかかります。</div>
          )}
        </div>
      </form>

      {error && <div className="alert alert-danger">{error}</div>}

      {data && (
        <>
          <div className="card border-0 shadow-sm mb-3">
            <div className="card-body">
              <h2 className="h5 fw-bold mb-1">{data.race.raceName || `race_id: ${data.race.raceId}`}</h2>
              <div className="text-muted small">{data.race.course}</div>
            </div>
          </div>

          <div className="table-responsive">
            <table className="table table-hover align-middle bg-white shadow-sm">
              <thead>
                <tr>
                  <th>予想順位</th>
                  <th>馬番</th>
                  <th>馬名</th>
                  <th>性齢</th>
                  <th>騎手</th>
                  <th>脚質</th>
                  <th>父</th>
                  <th>人気</th>
                  <th>スコア</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.predictions.map((p) => (
                  <Fragment key={p.horse.horseId}>
                    <tr>
                      <td>
                        <span className={`badge rounded-pill ${rankBadgeClass(p.rank)}`}>{p.rank}</span>
                      </td>
                      <td>{p.horse.umaban}</td>
                      <td className="fw-semibold">{p.horse.name}</td>
                      <td>{p.horse.sexAge}</td>
                      <td>{p.horse.jockey}</td>
                      <td>
                        <span className="badge bg-info-subtle text-info-emphasis">{p.runningStyle}</span>
                      </td>
                      <td>{p.pedigree.sire}</td>
                      <td>{p.horse.popularity ?? '-'}</td>
                      <td className="fw-bold">{p.score}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary"
                          onClick={() => setExpanded(expanded === p.horse.horseId ? null : p.horse.horseId)}
                        >
                          詳細
                        </button>
                      </td>
                    </tr>
                    {expanded === p.horse.horseId && (
                      <tr>
                        <td colSpan={10} className="bg-light">
                          <div className="row g-3 py-2">
                            <div className="col-md-6">
                              <div className="fw-semibold small mb-2">スコア内訳</div>
                              {(Object.keys(p.breakdown) as (keyof PredictionBreakdown)[]).map((key) => (
                                <div key={key} className="d-flex align-items-center gap-2 mb-1">
                                  <span className="small text-muted" style={{ width: 110 }}>
                                    {BREAKDOWN_LABELS[key]}
                                  </span>
                                  <div className="progress flex-grow-1" style={{ height: 6 }}>
                                    <div
                                      className="progress-bar"
                                      style={{ width: `${p.breakdown[key]}%` }}
                                    />
                                  </div>
                                  <span className="small text-muted" style={{ width: 32 }}>
                                    {Math.round(p.breakdown[key])}
                                  </span>
                                </div>
                              ))}
                            </div>
                            <div className="col-md-6">
                              <div className="fw-semibold small mb-2">血統（曾祖父母まで）</div>
                              <table className="table table-sm table-borderless mb-2 small">
                                <tbody>
                                  <tr>
                                    <td className="text-muted" style={{ width: 50 }}>
                                      父
                                    </td>
                                    <td colSpan={2}>{p.pedigree.sire || '不明'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">父父</td>
                                    <td>{p.pedigree.sireSire || '-'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">　├父父父</td>
                                    <td className="text-muted">{p.pedigree.sireSireSire || '-'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">　└父父母</td>
                                    <td className="text-muted">{p.pedigree.sireSireDam || '-'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">父母</td>
                                    <td>{p.pedigree.sireDam || '-'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">　├父母父</td>
                                    <td className="text-muted">{p.pedigree.sireDamSire || '-'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">　└父母母</td>
                                    <td className="text-muted">{p.pedigree.sireDamDam || '-'}</td>
                                  </tr>
                                  <tr>
                                    <td className="text-muted">母</td>
                                    <td colSpan={2}>{p.pedigree.dam || '不明'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">母父</td>
                                    <td>{p.pedigree.damSire || '-'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">　├母父父</td>
                                    <td className="text-muted">{p.pedigree.damSireSire || '-'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">　└母父母</td>
                                    <td className="text-muted">{p.pedigree.damSireDam || '-'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">母母</td>
                                    <td>{p.pedigree.damDam || '-'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">　├母母父</td>
                                    <td className="text-muted">{p.pedigree.damDamSire || '-'}</td>
                                  </tr>
                                  <tr>
                                    <td />
                                    <td className="text-muted">　└母母母</td>
                                    <td className="text-muted">{p.pedigree.damDamDam || '-'}</td>
                                  </tr>
                                </tbody>
                              </table>
                              <div className="small text-muted">
                                馬体重: {p.horse.horseWeight ?? '-'}kg (
                                {p.horse.horseWeightDiff != null && p.horse.horseWeightDiff >= 0 ? '+' : ''}
                                {p.horse.horseWeightDiff ?? '-'})
                              </div>
                              <div className="small text-muted">斤量: {p.horse.weightCarried}kg</div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-muted small mt-2">
            <i className="bi bi-info-circle me-1" />
            スコアは近走成績・距離/馬場適性・コンディション・血統・市場評価をもとにした簡易的な参考指標です。的中を保証するものではありません。
          </p>
        </>
      )}
    </div>
  )
}

export default Prediction
