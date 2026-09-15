import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import {
  fetchRaceCard,
  fetchHorseHistory,
  fetchPedigree,
  fetchRaceResult,
  discoverUpcomingRaceIds,
  discoverPastRaceIds,
  jitteredSleep,
  NetkeibaBlockedError,
} from './netkeiba'
import { scoreHorse, rankPredictions, suggestBets } from './predict'
import {
  saveRacePrediction,
  saveRaceResult,
  getHistory,
  getStats,
  getRecentPicks,
  getCachedHorse,
  saveCachedHorse,
  isRaceConfirmed,
  getStatsByPeriod,
  getRaceDetail,
} from './db'
import {
  getKyiRace,
  listKyiRaces,
  analyzeJrdbRace,
  getSedRace,
  getHjcRace,
  getJrdbRaceMeta,
  computeJrdbActualReturn,
  getJrdbRecentPicks,
  computeJrdbBacktestStats,
  computeJrdbBacktestTimeseries,
  searchJrdbRaces,
  invalidateJrdbCaches,
  warmJrdbCaches,
} from './jrdbParser'
import { syncJrdbData, type JrdbSyncProgress } from './jrdb'
import fs from 'node:fs'
import path from 'node:path'

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001

// 相手サーバーへの負荷を抑えるため、馬ごとの取得は直列 + ランダムな間隔を空けて行う
const REQUEST_INTERVAL_MS: [number, number] = [400, 900]
// レースとレースの間の休止(バッチ予想時)
const BETWEEN_RACES_INTERVAL_MS: [number, number] = [3000, 8000]
// 過去成績のキャッシュ有効期間。血統は不変なので無期限にキャッシュを使う。
const HISTORY_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000

async function getHorseData(horseId: string) {
  const cached = getCachedHorse(horseId)
  const historyFresh = !!cached && Date.now() - new Date(cached.historyFetchedAt).getTime() < HISTORY_CACHE_TTL_MS

  if (cached && historyFresh) {
    return { history: cached.history, pedigree: cached.pedigree }
  }

  await jitteredSleep(...REQUEST_INTERVAL_MS)
  const [history, pedigree] = await Promise.all([
    historyFresh ? Promise.resolve(cached!.history) : fetchHorseHistory(horseId),
    cached ? Promise.resolve(cached.pedigree) : fetchPedigree(horseId), // 血統は不変なのでキャッシュがあれば常に使う
  ])
  saveCachedHorse(horseId, pedigree, history)
  return { history, pedigree }
}

async function predictRace(raceId: string) {
  const race = await fetchRaceCard(raceId)
  if (race.horses.length === 0) return null

  const predictions = []
  for (const horse of race.horses) {
    const { history, pedigree } = await getHorseData(horse.horseId)
    predictions.push(scoreHorse(race, horse, history, pedigree))
  }

  const ranked = rankPredictions(predictions)
  const bets = suggestBets(ranked)
  saveRacePrediction(race, ranked, bets)
  return { race, predictions: ranked, bets }
}

app.get('/api/predict/:raceId', async (req, res) => {
  const { raceId } = req.params
  if (!/^\d{8,12}$/.test(raceId)) {
    res.status(400).json({ error: 'race_id の形式が不正です' })
    return
  }

  try {
    const result = await predictRace(raceId)
    if (!result) {
      res.status(404).json({ error: '出走馬が見つかりませんでした。race_id を確認してください。' })
      return
    }
    res.json(result)
  } catch (err) {
    console.error(err)
    const error =
      err instanceof NetkeibaBlockedError
        ? 'netkeibaからアクセス制限を受けた可能性があります。時間を置いてから再試行してください。'
        : 'netkeiba からのデータ取得に失敗しました。しばらく待って再試行してください。'
    res.status(502).json({ error })
  }
})

// レース確定後に実際の結果・払戻を取得し、保存済みの予想と照合する
app.post('/api/results/:raceId', async (req, res) => {
  const { raceId } = req.params
  if (!/^\d{8,12}$/.test(raceId)) {
    res.status(400).json({ error: 'race_id の形式が不正です' })
    return
  }

  try {
    const result = await fetchRaceResult(raceId)
    if (!result) {
      res.status(404).json({ error: 'このレースはまだ結果が確定していません。' })
      return
    }
    const { confirmed } = saveRaceResult(raceId, result)
    if (!confirmed) {
      res.status(404).json({ error: 'このレースの予想が保存されていません。先に /predict で予想を取得してください。' })
      return
    }
    res.json({ ok: true, result })
  } catch (err) {
    console.error(err)
    const error =
      err instanceof NetkeibaBlockedError
        ? 'netkeibaからアクセス制限を受けた可能性があります。時間を置いてから再試行してください。'
        : 'netkeiba からの結果取得に失敗しました。しばらく待って再試行してください。'
    res.status(502).json({ error })
  }
})

// 予想履歴の一覧
app.get('/api/history', (_req, res) => {
  res.json({ races: getHistory() })
})

// 予想履歴1件の詳細(買い目・実際の着順・的中結果)
app.get('/api/history/:raceId', (req, res) => {
  const detail = getRaceDetail(req.params.raceId)
  if (!detail) {
    res.status(404).json({ error: 'レースが見つかりません' })
    return
  }
  res.json({ detail })
})

function parseConfidenceFilter(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  return raw.split(',').filter(Boolean)
}

// 券種別の的中率・回収率(予算配分ベースの金額回収率)。
// granularity+periodで期間を、confidence(カンマ区切り、例: 堅い,やや堅い)で予想時の確信度を絞り込める。
app.get('/api/stats', (req, res) => {
  const granularity = req.query.granularity === 'month' ? 'month' : req.query.granularity === 'day' ? 'day' : null
  const period = typeof req.query.period === 'string' ? req.query.period : null
  const confidenceFilter = parseConfidenceFilter(req.query.confidence)
  const summary = granularity && period ? getStats({ granularity, period }, confidenceFilter) : getStats(undefined, confidenceFilter)
  res.json({ summary })
})

// ダッシュボードの回収率推移グラフ用(日別/月別)。confidenceで予想時の確信度を絞り込める。
app.get('/api/stats/timeseries', (req, res) => {
  const granularity = req.query.granularity === 'month' ? 'month' : 'day'
  const confidenceFilter = parseConfidenceFilter(req.query.confidence)
  res.json({ points: getStatsByPeriod(granularity, confidenceFilter) })
})

// ダッシュボード表示用: 直近N件の予想レースの自信がある買い目
app.get('/api/dashboard/recent-picks', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 4, 20)
  res.json({ picks: getRecentPicks(limit) })
})

// --- 複数レースの一括予想(時間がかかるためバックグラウンドジョブとして実行) ---

type BatchJob = {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  raceIds: string[]
  error?: string
}
const batchJobs = new Map<string, BatchJob>()

app.post('/api/batch-predict', (req, res) => {
  const count = Math.min(Math.max(Number(req.body?.count) || 4, 1), 10)
  const jobId = crypto.randomUUID()
  const job: BatchJob = { status: 'running', total: 0, completed: 0, raceIds: [] }
  batchJobs.set(jobId, job)
  res.json({ jobId })

  ;(async () => {
    try {
      const raceIds = await discoverUpcomingRaceIds(count)
      job.total = raceIds.length
      job.raceIds = raceIds
      for (let i = 0; i < raceIds.length; i++) {
        await predictRace(raceIds[i])
        job.completed++
        if (i < raceIds.length - 1) await jitteredSleep(...BETWEEN_RACES_INTERVAL_MS)
      }
      job.status = 'done'
    } catch (err) {
      console.error(err)
      job.status = 'error'
      job.error =
        err instanceof NetkeibaBlockedError
          ? 'netkeibaからアクセス制限を受けた可能性があるため中断しました。時間を置いてから再試行してください。'
          : err instanceof Error
            ? err.message
            : 'unknown error'
    }
  })()
})

app.get('/api/batch-predict/:jobId', (req, res) => {
  const job = batchJobs.get(req.params.jobId)
  if (!job) {
    res.status(404).json({ error: 'ジョブが見つかりません' })
    return
  }
  res.json(job)
})

// --- 過去レースの一括バックフィル(モデル精度検証用データ作成のための一時的な特例機能) ---
// 通常の利用(/predict, /api/batch-predict)より大幅に件数が多くなるため、
// レース間・日付間の休止をさらに長く取り、安全性を優先する。
const BACKFILL_BETWEEN_RACES_MS: [number, number] = [5000, 12000]

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
const backfillJobs = new Map<string, BackfillJob>()

app.post('/api/backfill', (req, res) => {
  const daysBack = Math.min(Math.max(Number(req.body?.daysBack) || 60, 1), 120)
  const jobId = crypto.randomUUID()
  const job: BackfillJob = {
    status: 'discovering',
    totalDays: daysBack,
    daysScanned: 0,
    racesFound: 0,
    racesCompleted: 0,
    racesSkipped: 0,
    racesFailed: 0,
    currentRaceId: null,
  }
  backfillJobs.set(jobId, job)
  res.json({ jobId })

  ;(async () => {
    try {
      const found = await discoverPastRaceIds(daysBack)
      job.racesFound = found.length
      job.daysScanned = daysBack
      job.status = 'running'

      for (let i = 0; i < found.length; i++) {
        const { raceId } = found[i]
        job.currentRaceId = raceId
        if (isRaceConfirmed(raceId)) {
          job.racesSkipped++
        } else {
          try {
            await predictRace(raceId)
            const result = await fetchRaceResult(raceId)
            if (result) saveRaceResult(raceId, result)
            job.racesCompleted++
          } catch (err) {
            if (err instanceof NetkeibaBlockedError) throw err // ブロック時は残りを消化せず即座に中断する
            console.error(`backfill failed for ${raceId}:`, err)
            job.racesFailed++
          }
        }
        if (i < found.length - 1) await jitteredSleep(...BACKFILL_BETWEEN_RACES_MS)
      }
      job.currentRaceId = null
      job.status = 'done'
    } catch (err) {
      console.error(err)
      job.status = 'error'
      job.error =
        err instanceof NetkeibaBlockedError
          ? 'netkeibaからアクセス制限を受けた可能性があるため中断しました。時間を置いてから再試行してください。'
          : err instanceof Error
            ? err.message
            : 'unknown error'
    }
  })()
})

app.get('/api/backfill/:jobId', (req, res) => {
  const job = backfillJobs.get(req.params.jobId)
  if (!job) {
    res.status(404).json({ error: 'ジョブが見つかりません' })
    return
  }
  res.json(job)
})

// 指定日にダウンロード済みのJRDBデータに含まれる開催場・レース番号の一覧
app.get('/api/jrdb/races', async (req, res) => {
  const dateStr = typeof req.query.date === 'string' ? req.query.date : null
  if (!dateStr) {
    res.status(400).json({ error: 'date(YYYY-MM-DD)を指定してください' })
    return
  }
  const races = await listKyiRaces(new Date(`${dateStr}T00:00:00`))
  res.json({ races })
})

// 日付・競馬場・レース番号を指定してJRDBの出走馬データ(指数つき)を取得
app.get('/api/jrdb/race', async (req, res) => {
  const dateStr = typeof req.query.date === 'string' ? req.query.date : null
  const venue = typeof req.query.venue === 'string' ? req.query.venue : null
  const raceNumber = Number(req.query.raceNumber)
  if (!dateStr || !venue || !raceNumber) {
    res.status(400).json({ error: 'date, venue, raceNumber を指定してください' })
    return
  }
  const race = await getKyiRace(new Date(`${dateStr}T00:00:00`), venue, raceNumber)
  if (!race) {
    res.status(404).json({ error: 'データが見つかりません(未ダウンロードの可能性があります)' })
    return
  }
  const analysis = analyzeJrdbRace(race.venueName, race.raceNumber, race.horses)

  const date = new Date(`${dateStr}T00:00:00`)
  const sed = await getSedRace(date, venue, raceNumber)
  const meta = sed ? getJrdbRaceMeta(sed.horses) : { raceName: null, gradeLabel: null, headCount: null }
  const hjc = await getHjcRace(date, venue, raceNumber)
  const actualReturn = sed && analysis?.bets ? computeJrdbActualReturn(analysis.bets, sed.horses, hjc) : null

  res.json({ race, analysis, meta, result: sed ? { finishOrder: sed.horses, actualReturn } : null })
})

// ダッシュボード表示用: JRDBデータから確度上位N件のレースを買い目つきで返す
app.get('/api/jrdb/recent-picks', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 4, 20)
  const picks = await getJrdbRecentPicks(limit)
  res.json({ picks })
})

// JRDBアーカイブ全体(または期間・確信度で絞り込み)を回した場合の券種別的中率・回収率
app.get('/api/jrdb/stats', async (req, res) => {
  const daysBack = req.query.daysBack != null ? Number(req.query.daysBack) : undefined
  const confidenceFilter = parseConfidenceFilter(req.query.confidence)
  const summary = await computeJrdbBacktestStats({ daysBack, confidenceFilter })
  res.json({ summary })
})

// ダッシュボードの回収率推移グラフ用(日別/月別)。JRDBアーカイブ全体をもとに算出する。
app.get('/api/jrdb/stats/timeseries', async (req, res) => {
  const granularity = req.query.granularity === 'month' ? 'month' : 'day'
  const confidenceFilter = parseConfidenceFilter(req.query.confidence)
  const points = await computeJrdbBacktestTimeseries(granularity, confidenceFilter)
  res.json({ points })
})

// 予測履歴ページ用: 期間・確信度で絞り込んだ検索可能なレース一覧(デフォルト直近3週間)
app.get('/api/jrdb/races/search', async (req, res) => {
  const rawDaysBack = req.query.daysBack != null ? Number(req.query.daysBack) : undefined
  // 10年分アーカイブを一度に全件スキャンさせないための安全上限(730日=約2年分)
  const daysBack = rawDaysBack != null && Number.isFinite(rawDaysBack) ? Math.min(Math.max(rawDaysBack, 1), 730) : undefined
  const confidenceFilter = parseConfidenceFilter(req.query.confidence)
  const venueName = typeof req.query.venue === 'string' ? req.query.venue : undefined
  const races = await searchJrdbRaces({ daysBack, confidenceFilter, venueName })
  res.json({ races })
})

// --- JRDBデータの同期(未取得分の取得) ---

const jrdbSyncJobs = new Map<string, JrdbSyncProgress>()

app.post('/api/jrdb/sync', (_req, res) => {
  const jobId = crypto.randomUUID()
  const job: JrdbSyncProgress = { status: 'running', totalChecks: 0, checked: 0, downloaded: 0, skippedNoData: 0, failed: 0 }
  jrdbSyncJobs.set(jobId, job)
  res.json({ jobId })

  syncJrdbData((p) => Object.assign(job, p))
    .then(async (result) => {
      markJrdbSynced()
      if (result.downloaded > 0) {
        invalidateJrdbCaches()
        await warmJrdbCaches()
      }
    })
    .catch((err) => {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : 'unknown error'
    })
})

app.get('/api/jrdb/sync/:jobId', (req, res) => {
  const job = jrdbSyncJobs.get(req.params.jobId)
  if (!job) {
    res.status(404).json({ error: 'ジョブが見つかりません' })
    return
  }
  res.json(job)
})

// 週次自動同期。サーバー起動中(=このプロセスが生きている間)、最後の同期から7日以上経っていれば自動で実行する。
const LAST_SYNC_FILE = path.join(import.meta.dirname, '..', 'data', 'jrdb', '.last-sync')
const AUTO_SYNC_INTERVAL_DAYS = 7
const AUTO_SYNC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 1日おきにチェック(実行自体は7日に1回程度)

function markJrdbSynced() {
  fs.mkdirSync(path.dirname(LAST_SYNC_FILE), { recursive: true })
  fs.writeFileSync(LAST_SYNC_FILE, new Date().toISOString())
}

function shouldAutoSyncJrdb(): boolean {
  try {
    const last = new Date(fs.readFileSync(LAST_SYNC_FILE, 'utf-8').trim())
    return (Date.now() - last.getTime()) / (1000 * 60 * 60 * 24) >= AUTO_SYNC_INTERVAL_DAYS
  } catch {
    return true // 記録が無ければ初回として実行
  }
}

async function runAutoJrdbSyncIfNeeded() {
  if (!shouldAutoSyncJrdb()) return
  console.log('[jrdb-sync] 週次自動更新を開始します')
  try {
    const result = await syncJrdbData()
    markJrdbSynced()
    console.log('[jrdb-sync] 完了:', result)
    if (result.downloaded > 0) {
      invalidateJrdbCaches()
      await warmJrdbCaches()
    }
  } catch (err) {
    console.error('[jrdb-sync] 失敗:', err)
  }
}

runAutoJrdbSyncIfNeeded()
setInterval(runAutoJrdbSyncIfNeeded, AUTO_SYNC_CHECK_INTERVAL_MS)

// ダッシュボードの初回表示が遅くならないよう、フィルタ無しの集計結果をあらかじめ計算してキャッシュしておく。
console.log('[jrdb-cache] キャッシュを温めています...')
warmJrdbCaches()
  .then(() => console.log('[jrdb-cache] キャッシュの準備ができました'))
  .catch((err) => console.error('[jrdb-cache] 失敗:', err))

// '0.0.0.0'を明示し、Tailscale等の他ネットワーク経由(スマホ含む)からもアクセスできるようにする
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Prediction API server listening on http://0.0.0.0:${PORT}`)
})
