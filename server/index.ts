import express from 'express'
import cors from 'cors'
import {
  fetchRaceCard,
  fetchHorseHistory,
  fetchPedigree,
  fetchRaceResult,
  discoverUpcomingRaceIds,
  sleep,
} from './netkeiba'
import { scoreHorse, rankPredictions, suggestBets } from './predict'
import { saveRacePrediction, saveRaceResult, getHistory, getStats, getRecentPicks } from './db'

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001

// 相手サーバーへの負荷を抑えるため、馬ごとの取得は直列 + インターバルを空けて行う
const REQUEST_INTERVAL_MS = 400

async function predictRace(raceId: string) {
  const race = await fetchRaceCard(raceId)
  if (race.horses.length === 0) return null

  const predictions = []
  for (const horse of race.horses) {
    await sleep(REQUEST_INTERVAL_MS)
    const [history, pedigree] = await Promise.all([
      fetchHorseHistory(horse.horseId),
      fetchPedigree(horse.horseId),
    ])
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
    res.status(502).json({ error: 'netkeiba からのデータ取得に失敗しました。しばらく待って再試行してください。' })
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
    res.status(502).json({ error: 'netkeiba からの結果取得に失敗しました。しばらく待って再試行してください。' })
  }
})

// 予想履歴の一覧
app.get('/api/history', (_req, res) => {
  res.json({ races: getHistory() })
})

// 券種別の的中率・回収率(100円/点換算)
app.get('/api/stats', (_req, res) => {
  res.json({ stats: getStats() })
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
      for (const raceId of raceIds) {
        await predictRace(raceId)
        job.completed++
      }
      job.status = 'done'
    } catch (err) {
      console.error(err)
      job.status = 'error'
      job.error = err instanceof Error ? err.message : 'unknown error'
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

app.listen(PORT, () => {
  console.log(`Prediction API server listening on http://localhost:${PORT}`)
})
