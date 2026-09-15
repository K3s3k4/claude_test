import { useEffect, useState } from 'react'

type Confidence = '堅い' | 'やや堅い' | '混戦'

type RaceOption = { venueCode: string; venueName: string; raceNumber: number; confidenceLabel: Confidence }

type KyiHorse = {
  umaban: number
  horseName: string
  jockeyName: string
  trainerName: string
  idm: number | null
  overallIndex: number | null
  jockeyIndex: number | null
  infoIndex: number | null
  baseOdds: number | null
  basePopularity: number | null
  popularityIndex: number | null
  trainingIndex: number | null
  stableIndex: number | null
  runningStyleCode: number | null
  tenIndex: number | null
  paceIndex: number | null
  agariIndex: number | null
  positionIndex: number | null
  paceForecast: string | null
  turfAptCode: string | null
  dirtAptCode: string | null
}

type RaceResult = { venueName: string; raceNumber: number; horses: KyiHorse[] }
type AnalyzedHorse = KyiHorse & { winProbability: number; placeProbability: number }

type Pick = { umaban: number; name: string }
type PricedPick = { pick: Pick; stakeYen: number }
type Combo = { picks: Pick[]; probability: number; stakeYen: number }

type BetSuggestions = {
  boxSize: number
  tansho: (PricedPick & { winProbability: number })[]
  fukusho: (PricedPick & { placeProbability: number })[]
  umaren: Combo[]
  wide: Combo[]
  umatan: Combo[]
  sanrenpuku: Combo[]
  sanrentan: Combo[]
  totalStakeYen: number
}

type RaceAnalysis = {
  confidenceScore: number
  confidenceLabel: Confidence
  probabilityGap: number
  topPickSummary: string
  leadSummary: string
  horses: AnalyzedHorse[]
  bets: BetSuggestions | null
}

type RaceMeta = { raceName: string | null; gradeLabel: string | null; headCount: number | null }

type FinishHorse = {
  umaban: number
  horseName: string
  finishPosition: number | null
  timeSeconds: number | null
  confirmedOdds: number | null
  confirmedPopularity: number | null
  jockeyName: string
  tanshoPayout: number | null
  fukushoPayout: number | null
}

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
type ResultData = { finishOrder: FinishHorse[]; actualReturn: ActualReturn | null }

function confidenceBadgeClass(label: Confidence) {
  if (label === '堅い') return 'bg-success'
  if (label === 'やや堅い') return 'bg-primary'
  return 'bg-danger'
}

function confidenceButtonClass(label: Confidence, active: boolean) {
  if (active) return 'btn-dark'
  if (label === '堅い') return 'btn-outline-success'
  if (label === 'やや堅い') return 'btn-outline-primary'
  return 'btn-outline-danger'
}

function confidenceScoreClass(score: number) {
  if (score >= 80) return 'text-success'
  if (score >= 60) return 'text-primary'
  return 'text-danger'
}

const RUNNING_STYLE_LABELS: Record<number, string> = {
  1: '逃げ',
  2: '先行',
  3: '差し',
  4: '追込',
}

const APT_LABELS: Record<string, string> = {
  '1': '◎',
  '2': '○',
  '3': '△',
}

function fmt(v: number | null, unit = '') {
  return v == null ? '-' : `${v}${unit}`
}

function formatTime(seconds: number | null) {
  if (seconds == null) return '-'
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(1)
  return `${m}:${s.padStart(4, '0')}`
}

function todayStr() {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

function StakeBadge({ stakeYen }: { stakeYen: number }) {
  if (stakeYen <= 0) return null
  return (
    <span className="badge bg-warning-subtle text-warning-emphasis border border-warning-subtle ms-1">
      {stakeYen.toLocaleString()}円({stakeYen / 100}口)
    </span>
  )
}

function CombosRow({ label, combos, ordered = false }: { label: string; combos: Combo[]; ordered?: boolean }) {
  if (combos.length === 0) return null
  const separator = ordered ? '→' : '-'
  return (
    <div className="mb-2">
      <div className="text-muted small mb-1">
        {label}
        <span className="ms-1">({combos.length}点)</span>
      </div>
      <div className="d-flex flex-wrap gap-1">
        {combos.map((combo, i) => (
          <span key={i} className="badge bg-light text-dark border fw-normal">
            {combo.picks.map((p) => `${p.umaban}`).join(separator)}
            <span className="text-muted ms-1">{(combo.probability * 100).toFixed(1)}%</span>
            <StakeBadge stakeYen={combo.stakeYen} />
          </span>
        ))}
      </div>
    </div>
  )
}

function JrdbSearch() {
  const [date, setDate] = useState(todayStr())
  const [raceOptions, setRaceOptions] = useState<RaceOption[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [result, setResult] = useState<RaceResult | null>(null)
  const [analysis, setAnalysis] = useState<RaceAnalysis | null>(null)
  const [meta, setMeta] = useState<RaceMeta | null>(null)
  const [resultData, setResultData] = useState<ResultData | null>(null)
  const [loadingRaces, setLoadingRaces] = useState(false)
  const [loadingRace, setLoadingRace] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<'umaban' | 'overallIndex' | 'baseOdds' | 'winProbability'>('winProbability')

  useEffect(() => {
    setLoadingRaces(true)
    setError(null)
    setResult(null)
    setSelectedKey(null)
    fetch(`/api/jrdb/races?date=${date}`)
      .then((r) => r.json())
      .then((json) => setRaceOptions(json.races))
      .catch(() => setError('レース一覧の取得に失敗しました'))
      .finally(() => setLoadingRaces(false))
  }, [date])

  async function handleSelectRace(opt: RaceOption) {
    const key = `${opt.venueCode}-${opt.raceNumber}`
    setSelectedKey(key)
    setLoadingRace(true)
    setError(null)
    try {
      const res = await fetch(`/api/jrdb/race?date=${date}&venue=${encodeURIComponent(opt.venueName)}&raceNumber=${opt.raceNumber}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || '取得に失敗しました')
      setResult(json.race)
      setAnalysis(json.analysis)
      setMeta(json.meta)
      setResultData(json.result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '取得に失敗しました')
      setResult(null)
      setAnalysis(null)
      setMeta(null)
      setResultData(null)
    } finally {
      setLoadingRace(false)
    }
  }

  const sortedHorses = analysis
    ? [...analysis.horses].sort((a, b) => {
        if (sortKey === 'umaban') return a.umaban - b.umaban
        if (sortKey === 'baseOdds') return (a.baseOdds ?? 9999) - (b.baseOdds ?? 9999)
        if (sortKey === 'winProbability') return b.winProbability - a.winProbability
        return (b.overallIndex ?? -9999) - (a.overallIndex ?? -9999)
      })
    : []

  const venuesForDate = [...new Set(raceOptions.map((r) => r.venueName))]
  const bets = analysis?.bets

  return (
    <div className="container py-4">
      <div className="mb-4">
        <h1 className="h3 fw-bold mb-1">JRDB検索</h1>
        <p className="text-muted mb-0">
          ダウンロード済みのJRDBデータ(競走馬データ)から、日付・競馬場・レース番号を指定して出走馬の指数を検索します。
        </p>
      </div>

      <div className="card border-0 shadow-sm mb-4">
        <div className="card-body">
          <div className="row g-3 align-items-end">
            <div className="col-auto">
              <label htmlFor="jrdb-date" className="form-label small text-muted mb-1">
                開催日
              </label>
              <input
                id="jrdb-date"
                type="date"
                className="form-control"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="col">
              {loadingRaces ? (
                <p className="text-muted small mb-0">レースを検索中...</p>
              ) : raceOptions.length === 0 ? (
                <p className="text-muted small mb-0">
                  この日のデータはありません(未ダウンロード、または開催がない日です)。
                </p>
              ) : (
                <div>
                  {venuesForDate.map((venueName) => (
                    <div key={venueName} className="mb-2">
                      <span className="text-muted small me-2">{venueName}:</span>
                      <div className="d-inline-flex flex-wrap gap-1">
                        {raceOptions
                          .filter((r) => r.venueName === venueName)
                          .map((opt) => {
                            const key = `${opt.venueCode}-${opt.raceNumber}`
                            const active = selectedKey === key
                            return (
                              <button
                                key={key}
                                type="button"
                                className={`btn btn-sm ${confidenceButtonClass(opt.confidenceLabel, active)}`}
                                title={opt.confidenceLabel}
                                onClick={() => handleSelectRace(opt)}
                              >
                                {opt.raceNumber}R
                              </button>
                            )
                          })}
                      </div>
                    </div>
                  ))}
                  <p className="text-muted small mb-0 mt-2">
                    <i className="bi bi-info-circle me-1" />
                    ボタンの色は確信度(緑=堅い・青=やや堅い・赤=混戦)を表します。
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      {loadingRace ? (
        <p className="text-muted small">読み込み中...</p>
      ) : (
        result &&
        analysis && (
          <>
            <div className="card border-0 shadow-sm mb-3">
              <div className="card-body">
                <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
                  <h2 className="h6 fw-bold mb-0">
                    {result.venueName} {result.raceNumber}R
                    {meta?.raceName && ` ${meta.raceName}`}
                    {meta?.gradeLabel && ` (${meta.gradeLabel})`}
                  </h2>
                  <span className={`badge ${confidenceBadgeClass(analysis.confidenceLabel)}`}>{analysis.confidenceLabel}</span>
                  <span className={`small fw-bold ${confidenceScoreClass(analysis.confidenceScore)}`}>
                    確度 {analysis.confidenceScore}
                    <span className="text-muted fw-normal">/100</span>
                  </span>
                  {resultData && <span className="badge bg-secondary-subtle text-secondary-emphasis">確定済み</span>}
                </div>
                <p className="mb-2">{analysis.leadSummary}</p>
                <p className="text-muted small mb-0">{analysis.topPickSummary}</p>
              </div>
            </div>

            {bets && (
              <div className="card border-0 shadow-sm mb-3">
                <div className="card-body">
                  <div className="d-flex align-items-center gap-2 mb-3 flex-wrap">
                    <h2 className="h6 fw-bold mb-0">推奨買い目</h2>
                    <span className="text-muted small">予算3,000円を券種均等配分・確率比例で100円単位配分</span>
                  </div>
                  <div className="row g-3">
                    <div className="col-md-6">
                      <div className="mb-2">
                        <div className="text-muted small mb-1">単勝</div>
                        {bets.tansho.map((t) => (
                          <div key={t.pick.umaban} className="d-flex align-items-center gap-2 flex-wrap">
                            <span className="badge bg-white text-dark border">
                              {t.pick.umaban} {t.pick.name}
                            </span>
                            <span className="text-muted small">推定勝率 {(t.winProbability * 100).toFixed(1)}%</span>
                            <StakeBadge stakeYen={t.stakeYen} />
                          </div>
                        ))}
                      </div>
                      <div className="mb-2">
                        <div className="text-muted small mb-1">複勝</div>
                        {bets.fukusho.map((f) => (
                          <div key={f.pick.umaban} className="d-flex align-items-center gap-2 flex-wrap">
                            <span className="badge bg-white text-dark border">
                              {f.pick.umaban} {f.pick.name}
                            </span>
                            <span className="text-muted small">推定複勝率 {(f.placeProbability * 100).toFixed(1)}%</span>
                            <StakeBadge stakeYen={f.stakeYen} />
                          </div>
                        ))}
                      </div>
                      <CombosRow label="馬連" combos={bets.umaren} />
                      <CombosRow label="ワイド" combos={bets.wide} />
                    </div>
                    <div className="col-md-6">
                      <CombosRow label="馬単" combos={bets.umatan} ordered />
                      <CombosRow label="三連複" combos={bets.sanrenpuku} />
                      <CombosRow label="三連単" combos={bets.sanrentan} ordered />
                    </div>
                  </div>
                  <div className="small fw-semibold mt-2">合計購入額: {bets.totalStakeYen.toLocaleString()}円</div>
                </div>
              </div>
            )}

            {resultData && (
              <div className="card border-0 shadow-sm mb-3">
                <div className="card-body">
                  <h2 className="h6 fw-bold mb-3">結果</h2>
                  <div className="table-responsive mb-3">
                    <table className="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>着順</th>
                          <th>馬番</th>
                          <th>馬名</th>
                          <th>騎手</th>
                          <th>タイム</th>
                          <th>確定オッズ</th>
                          <th>確定人気</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resultData.finishOrder.slice(0, 5).map((h) => (
                          <tr key={h.umaban}>
                            <td className="fw-semibold">{h.finishPosition ?? '-'}</td>
                            <td>{h.umaban}</td>
                            <td className="fw-semibold text-nowrap">{h.horseName}</td>
                            <td className="text-nowrap">{h.jockeyName}</td>
                            <td>{formatTime(h.timeSeconds)}</td>
                            <td>{fmt(h.confirmedOdds, '倍')}</td>
                            <td>{fmt(h.confirmedPopularity, '番人気')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {resultData.actualReturn && (
                    <>
                      <div className="d-flex flex-wrap gap-3 mb-2 small">
                        <span>
                          購入額: <span className="fw-semibold">{resultData.actualReturn.totalStakeYen.toLocaleString()}円</span>
                        </span>
                        <span>
                          払戻: <span className="fw-semibold">{resultData.actualReturn.totalPayoutYen.toLocaleString()}円</span>
                        </span>
                        <span>
                          回収率:{' '}
                          <span
                            className={`fw-semibold ${
                              resultData.actualReturn.returnRate != null && resultData.actualReturn.returnRate >= 100
                                ? 'text-success'
                                : 'text-danger'
                            }`}
                          >
                            {resultData.actualReturn.returnRate != null ? `${resultData.actualReturn.returnRate}%` : '-'}
                          </span>
                        </span>
                      </div>
                      {(
                        [
                          ['単勝', resultData.actualReturn.tansho],
                          ['複勝', resultData.actualReturn.fukusho],
                          ['馬連', resultData.actualReturn.umaren],
                          ['ワイド', resultData.actualReturn.wide],
                          ['馬単', resultData.actualReturn.umatan],
                          ['三連複', resultData.actualReturn.sanrenpuku],
                          ['三連単', resultData.actualReturn.sanrentan],
                        ] as [string, ActualBet[]][]
                      )
                        .filter(([, bets]) => bets.length > 0)
                        .map(([label, betList]) => (
                          <div key={label} className="d-flex align-items-center flex-wrap gap-1 mb-1">
                            <span className="text-muted small me-1">{label}:</span>
                            {betList.map((b, i) => (
                              <span
                                key={i}
                                className={`badge fw-normal border ${b.hit ? 'bg-success-subtle text-success-emphasis' : 'bg-light text-muted'}`}
                              >
                                {b.picks.map((p) => p.umaban).join('-')} {b.hit ? `的中 ${b.payoutYen.toLocaleString()}円` : '不的中'}
                              </span>
                            ))}
                          </div>
                        ))}
                      {resultData.actualReturn.note && (
                        <p className="text-muted small mb-0 mt-2">
                          <i className="bi bi-info-circle me-1" />
                          {resultData.actualReturn.note}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="card border-0 shadow-sm">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
                  <h2 className="h6 fw-bold mb-0">出走馬一覧({result.horses.length}頭)</h2>
                  <select
                    className="form-select form-select-sm"
                    style={{ width: 'auto' }}
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
                  >
                    <option value="winProbability">推定勝率順</option>
                    <option value="overallIndex">総合指数順</option>
                    <option value="baseOdds">基準オッズ順</option>
                    <option value="umaban">馬番順</option>
                  </select>
                </div>
                <div className="table-responsive">
                  <table className="table table-sm align-middle mb-0">
                    <thead>
                      <tr>
                        <th>馬番</th>
                        <th>馬名</th>
                        <th>推定勝率</th>
                        <th>複勝率</th>
                        <th>騎手</th>
                        <th>調教師</th>
                        <th>脚質</th>
                        <th>IDM</th>
                        <th>総合指数</th>
                        <th>騎手指数</th>
                        <th>基準オッズ</th>
                        <th>基準人気</th>
                        <th>調教指数</th>
                        <th>厩舎指数</th>
                        <th>芝/ダ適性</th>
                        <th>展開(テン/ペース/上がり/位置)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedHorses.map((h) => (
                        <tr key={h.umaban}>
                          <td>{h.umaban}</td>
                          <td className="fw-semibold text-nowrap">{h.horseName}</td>
                          <td className="fw-semibold">{(h.winProbability * 100).toFixed(1)}%</td>
                          <td className="text-muted">{(h.placeProbability * 100).toFixed(1)}%</td>
                          <td className="text-nowrap">{h.jockeyName}</td>
                          <td className="text-nowrap">{h.trainerName}</td>
                          <td>{h.runningStyleCode != null ? RUNNING_STYLE_LABELS[h.runningStyleCode] ?? '-' : '-'}</td>
                          <td>{fmt(h.idm)}</td>
                          <td className="fw-semibold">{fmt(h.overallIndex)}</td>
                          <td>{fmt(h.jockeyIndex)}</td>
                          <td>{fmt(h.baseOdds, '倍')}</td>
                          <td>{fmt(h.basePopularity, '番人気')}</td>
                          <td>{fmt(h.trainingIndex)}</td>
                          <td>{fmt(h.stableIndex)}</td>
                          <td>
                            {h.turfAptCode ? APT_LABELS[h.turfAptCode] ?? '-' : '-'}/{h.dirtAptCode ? APT_LABELS[h.dirtAptCode] ?? '-' : '-'}
                          </td>
                          <td className="text-muted small text-nowrap">
                            {fmt(h.tenIndex)}/{fmt(h.paceIndex)}/{fmt(h.agariIndex)}/{fmt(h.positionIndex)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-muted small mb-0 mt-2">
                  <i className="bi bi-info-circle me-1" />
                  推定勝率・複勝率・確度スコア・分析文は、JRDBの総合指数をもとに/predictと同じsoftmax・確度算出ロジックで機械的に算出した参考値です。IDM・各種指数はJRDB独自の評価値(高いほど能力上位)。基準オッズ・基準人気はJRDBが基準とする時点のもので、最終オッズとは異なる場合があります。
                </p>
              </div>
            </div>
          </>
        )
      )}
    </div>
  )
}

export default JrdbSearch
