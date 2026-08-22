import express from 'express'
import cors from 'cors'
import { fetchRaceCard, fetchHorseHistory, fetchPedigree, fetchRaceResult, sleep } from './netkeiba'
import { scoreHorse, rankPredictions, suggestBets } from './predict'
import { saveRacePrediction, saveRaceResult, getHistory, getStats } from './db'

const app = express()
app.use(cors())

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001

// 相手サーバーへの負荷を抑えるため、馬ごとの取得は直列 + インターバルを空けて行う
const REQUEST_INTERVAL_MS = 400

app.get('/api/predict/:raceId', async (req, res) => {
  const { raceId } = req.params
  if (!/^\d{8,12}$/.test(raceId)) {
    res.status(400).json({ error: 'race_id の形式が不正です' })
    return
  }

  try {
    const race = await fetchRaceCard(raceId)
    if (race.horses.length === 0) {
      res.status(404).json({ error: '出走馬が見つかりませんでした。race_id を確認してください。' })
      return
    }

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
    res.json({ race, predictions: ranked, bets })
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

app.listen(PORT, () => {
  console.log(`Prediction API server listening on http://localhost:${PORT}`)
})
