import express from 'express'
import cors from 'cors'
import { fetchRaceCard, fetchHorseHistory, fetchPedigree, sleep } from './netkeiba'
import { scoreHorse, rankPredictions } from './predict'

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
    res.json({ race, predictions: ranked })
  } catch (err) {
    console.error(err)
    res.status(502).json({ error: 'netkeiba からのデータ取得に失敗しました。しばらく待って再試行してください。' })
  }
})

app.listen(PORT, () => {
  console.log(`Prediction API server listening on http://localhost:${PORT}`)
})
