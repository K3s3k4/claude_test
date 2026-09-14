import Database from 'better-sqlite3'
import path from 'node:path'
import type { RaceCard, PastRace, Pedigree } from './netkeiba'
import type { RaceResult } from './netkeiba'
import type { HorsePrediction, BetSuggestions, PredictionBreakdown, RunningStyle } from './predict'
import { confidenceScore, describeAxisPick } from './predict'
import { allocateRaceStakes, DEFAULT_BUDGET_YEN } from './stake'

const DB_PATH = path.join(import.meta.dirname, '..', 'data', 'predictions.db')

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS races (
  race_id TEXT PRIMARY KEY,
  race_name TEXT,
  course TEXT,
  distance INTEGER,
  surface TEXT,
  track_condition TEXT,
  predicted_at TEXT NOT NULL,
  confirmed_at TEXT,
  confidence TEXT,
  probability_gap REAL,
  box_size INTEGER,
  venue TEXT,
  race_date TEXT
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id TEXT NOT NULL REFERENCES races(race_id),
  horse_id TEXT NOT NULL,
  umaban INTEGER NOT NULL,
  name TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  win_probability REAL NOT NULL,
  place_probability REAL NOT NULL,
  finish_position INTEGER
);
CREATE INDEX IF NOT EXISTS idx_predictions_race ON predictions(race_id);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id TEXT NOT NULL REFERENCES races(race_id),
  bet_type TEXT NOT NULL,
  umaban_combo TEXT NOT NULL,
  probability REAL NOT NULL,
  hit INTEGER,
  payout INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bets_race ON bets(race_id);
CREATE INDEX IF NOT EXISTS idx_bets_type ON bets(bet_type);

-- netkeibaへの重複アクセスを避けるための馬ごとのキャッシュ。
-- 血統は不変なので無期限、過去成績はTTL付き(呼び出し側で判定)で使う。
CREATE TABLE IF NOT EXISTS horse_cache (
  horse_id TEXT PRIMARY KEY,
  pedigree_json TEXT NOT NULL,
  pedigree_fetched_at TEXT NOT NULL,
  history_json TEXT NOT NULL,
  history_fetched_at TEXT NOT NULL
);
`)

// 既存DBファイルに新しいカラムを後から追加するための簡易マイグレーション
function ensureColumn(table: string, column: string, declaration: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
  }
}
ensureColumn('races', 'confidence', 'TEXT')
ensureColumn('races', 'probability_gap', 'REAL')
ensureColumn('races', 'box_size', 'INTEGER')
ensureColumn('races', 'venue', 'TEXT')
ensureColumn('races', 'race_date', 'TEXT')
ensureColumn('predictions', 'detail_json', 'TEXT')

// 着順を問わない券種(馬連/ワイド/三連複)は昇順に正規化し、
// 着順固定の券種(馬単/三連単)は推定順のまま比較キーにする
const ORDERED_BET_TYPES = new Set(['umatan', 'sanrentan'])

function canonicalCombo(umaban: number[], ordered: boolean): string {
  return (ordered ? umaban : [...umaban].sort((a, b) => a - b)).join(',')
}

export function saveRacePrediction(
  race: RaceCard,
  predictions: HorsePrediction[],
  bets: BetSuggestions | null,
): void {
  const existing = db.prepare('SELECT confirmed_at FROM races WHERE race_id = ?').get(race.raceId) as
    | { confirmed_at: string | null }
    | undefined
  if (existing?.confirmed_at) return // 結果確定済みのレースは予想を上書きしない

  const upsertRace = db.prepare(`
    INSERT INTO races (race_id, race_name, course, distance, surface, track_condition, predicted_at,
                        confidence, probability_gap, box_size, venue, race_date)
    VALUES (@raceId, @raceName, @course, @distance, @surface, @trackCondition, @predictedAt,
            @confidence, @probabilityGap, @boxSize, @venue, @raceDate)
    ON CONFLICT(race_id) DO UPDATE SET
      race_name=excluded.race_name, course=excluded.course, distance=excluded.distance,
      surface=excluded.surface, track_condition=excluded.track_condition, predicted_at=excluded.predicted_at,
      confidence=excluded.confidence, probability_gap=excluded.probability_gap, box_size=excluded.box_size,
      venue=excluded.venue, race_date=excluded.race_date
  `)

  const deletePredictions = db.prepare('DELETE FROM predictions WHERE race_id = ?')
  const deleteBets = db.prepare('DELETE FROM bets WHERE race_id = ?')
  const insertPrediction = db.prepare(`
    INSERT INTO predictions (race_id, horse_id, umaban, name, rank, score, win_probability, place_probability, detail_json)
    VALUES (@raceId, @horseId, @umaban, @name, @rank, @score, @winProbability, @placeProbability, @detailJson)
  `)
  const insertBet = db.prepare(`
    INSERT INTO bets (race_id, bet_type, umaban_combo, probability)
    VALUES (@raceId, @betType, @umabanCombo, @probability)
  `)

  const tx = db.transaction(() => {
    upsertRace.run({
      raceId: race.raceId,
      raceName: race.raceName,
      course: race.course,
      distance: race.distance,
      surface: race.surface,
      trackCondition: race.trackCondition,
      predictedAt: new Date().toISOString(),
      confidence: bets?.confidence ?? null,
      probabilityGap: bets?.probabilityGap ?? null,
      boxSize: bets?.boxSize ?? null,
      venue: race.venue,
      raceDate: race.date,
    })
    deletePredictions.run(race.raceId)
    deleteBets.run(race.raceId)

    for (const p of predictions) {
      insertPrediction.run({
        raceId: race.raceId,
        horseId: p.horse.horseId,
        umaban: p.horse.umaban,
        name: p.horse.name,
        rank: p.rank,
        score: p.score,
        winProbability: p.winProbability,
        placeProbability: p.placeProbability,
        detailJson: JSON.stringify({
          breakdown: p.breakdown,
          runningStyle: p.runningStyle,
          winEv: p.winEv,
          odds: p.horse.odds,
          popularity: p.horse.popularity,
        }),
      })
    }

    if (bets) {
      const groups: [string, { picks: { umaban: number }[] }[]][] = [
        ['tansho', bets.tansho.map((t) => ({ picks: [{ umaban: t.pick.umaban }] }))],
        ['fukusho', bets.fukusho.map((f) => ({ picks: [{ umaban: f.pick.umaban }] }))],
        ['umaren', bets.umaren],
        ['wide', bets.wide],
        ['umatan', bets.umatan],
        ['sanrenpuku', bets.sanrenpuku],
        ['sanrentan', bets.sanrentan],
      ]
      const probByType: Record<string, number[]> = {
        tansho: bets.tansho.map((t) => t.winProbability),
        fukusho: bets.fukusho.map((f) => f.placeProbability),
        umaren: bets.umaren.map((c) => c.probability),
        wide: bets.wide.map((c) => c.probability),
        umatan: bets.umatan.map((c) => c.probability),
        sanrenpuku: bets.sanrenpuku.map((c) => c.probability),
        sanrentan: bets.sanrentan.map((c) => c.probability),
      }

      for (const [betType, combos] of groups) {
        combos.forEach((combo, i) => {
          insertBet.run({
            raceId: race.raceId,
            betType,
            umabanCombo: canonicalCombo(
              combo.picks.map((p) => p.umaban),
              ORDERED_BET_TYPES.has(betType),
            ),
            probability: probByType[betType][i] ?? 0,
          })
        })
      }
    }
  })
  tx()
}

// バックフィルの再実行時、既に結果確定済みのレースをスキップして安全に再開できるようにする
export function isRaceConfirmed(raceId: string): boolean {
  const row = db.prepare('SELECT confirmed_at FROM races WHERE race_id = ?').get(raceId) as
    | { confirmed_at: string | null }
    | undefined
  return !!row?.confirmed_at
}

export function saveRaceResult(raceId: string, result: RaceResult): { confirmed: boolean } {
  const raceRow = db.prepare('SELECT race_id FROM races WHERE race_id = ?').get(raceId)
  if (!raceRow) return { confirmed: false } // 予想を保存していないレースの結果は無視

  const updateFinish = db.prepare(
    'UPDATE predictions SET finish_position = ? WHERE race_id = ? AND horse_id = ?',
  )
  const confirmRace = db.prepare('UPDATE races SET confirmed_at = ? WHERE race_id = ?')
  const getBets = db.prepare('SELECT id, bet_type, umaban_combo FROM bets WHERE race_id = ?')
  const settleBet = db.prepare('UPDATE bets SET hit = ?, payout = ? WHERE id = ?')

  const tx = db.transaction(() => {
    for (const h of result.finishOrder) {
      updateFinish.run(h.finishPosition || null, raceId, h.horseId)
    }

    const payoutMap: Record<string, Map<string, number>> = {}
    for (const [betType, combos] of Object.entries(result.payouts)) {
      const map = new Map<string, number>()
      for (const c of combos) {
        map.set(canonicalCombo(c.umaban, ORDERED_BET_TYPES.has(betType)), c.payout)
      }
      payoutMap[betType] = map
    }

    const rows = getBets.all(raceId) as { id: number; bet_type: string; umaban_combo: string }[]
    for (const row of rows) {
      const payout = payoutMap[row.bet_type]?.get(row.umaban_combo)
      settleBet.run(payout != null ? 1 : 0, payout ?? 0, row.id)
    }

    confirmRace.run(new Date().toISOString(), raceId)
  })
  tx()
  return { confirmed: true }
}

export type CachedHorse = {
  pedigree: Pedigree
  pedigreeFetchedAt: string
  history: PastRace[]
  historyFetchedAt: string
}

export function getCachedHorse(horseId: string): CachedHorse | null {
  const row = db.prepare('SELECT * FROM horse_cache WHERE horse_id = ?').get(horseId) as
    | {
        pedigree_json: string
        pedigree_fetched_at: string
        history_json: string
        history_fetched_at: string
      }
    | undefined
  if (!row) return null
  return {
    pedigree: JSON.parse(row.pedigree_json),
    pedigreeFetchedAt: row.pedigree_fetched_at,
    history: JSON.parse(row.history_json),
    historyFetchedAt: row.history_fetched_at,
  }
}

export function saveCachedHorse(horseId: string, pedigree: Pedigree, history: PastRace[]): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO horse_cache (horse_id, pedigree_json, pedigree_fetched_at, history_json, history_fetched_at)
     VALUES (@horseId, @pedigreeJson, @now, @historyJson, @now)
     ON CONFLICT(horse_id) DO UPDATE SET
       pedigree_json=excluded.pedigree_json, pedigree_fetched_at=excluded.pedigree_fetched_at,
       history_json=excluded.history_json, history_fetched_at=excluded.history_fetched_at`,
  ).run({
    horseId,
    pedigreeJson: JSON.stringify(pedigree),
    historyJson: JSON.stringify(history),
    now,
  })
}

export function getHistory() {
  return db
    .prepare(
      `SELECT race_id as raceId, race_name as raceName, course, venue, race_date as raceDate,
              predicted_at as predictedAt, confirmed_at as confirmedAt, confidence
       FROM races ORDER BY predicted_at DESC LIMIT 100`,
    )
    .all()
}

export type RecentPickCombo = { umabanCombo: string; names: string; probability: number }
export type AxisAnalysis = {
  umaban: number
  horseName: string
  winProbability: number
  runningStyle: RunningStyle
  breakdown: PredictionBreakdown
  summary: string
}
export type RecentPick = {
  raceId: string
  raceName: string
  course: string
  venue: string
  raceDate: string
  predictedAt: string
  confidence: string | null
  probabilityGap: number | null
  confidenceScore: number | null
  betsByType: Record<string, RecentPickCombo[]>
  axisAnalysis: AxisAnalysis | null
}

// ダッシュボード表示用: 直近N件の予想レースについて、券種ごとの上位買い目(馬名つき)を返す
export function getRecentPicks(limit = 4): RecentPick[] {
  const races = db
    .prepare(
      `SELECT race_id as raceId, race_name as raceName, course, venue, race_date as raceDate,
              predicted_at as predictedAt, confidence, probability_gap as probabilityGap
       FROM races ORDER BY predicted_at DESC LIMIT ?`,
    )
    .all(limit) as {
    raceId: string
    raceName: string
    course: string
    venue: string
    raceDate: string
    predictedAt: string
    confidence: string | null
    probabilityGap: number | null
  }[]

  if (races.length === 0) return []

  const raceIds = races.map((r) => r.raceId)
  const placeholders = raceIds.map(() => '?').join(',')

  const bets = db
    .prepare(
      `SELECT race_id as raceId, bet_type as betType, umaban_combo as umabanCombo, probability
       FROM bets WHERE race_id IN (${placeholders})`,
    )
    .all(...raceIds) as { raceId: string; betType: string; umabanCombo: string; probability: number }[]

  const predictions = db
    .prepare(
      `SELECT race_id as raceId, umaban, name, rank, win_probability as winProbability, detail_json as detailJson
       FROM predictions WHERE race_id IN (${placeholders})`,
    )
    .all(...raceIds) as {
    raceId: string
    umaban: number
    name: string
    rank: number
    winProbability: number
    detailJson: string | null
  }[]

  const nameByRaceUmaban = new Map<string, string>()
  for (const p of predictions) {
    nameByRaceUmaban.set(`${p.raceId}:${p.umaban}`, p.name)
  }

  const axisByRace = new Map<string, (typeof predictions)[number]>()
  for (const p of predictions) {
    if (p.rank === 1) axisByRace.set(p.raceId, p)
  }

  return races.map((r) => {
    const betsByType: Record<string, RecentPickCombo[]> = {}
    for (const b of bets.filter((x) => x.raceId === r.raceId)) {
      const names = b.umabanCombo
        .split(',')
        .map((u) => nameByRaceUmaban.get(`${r.raceId}:${u}`) ?? u)
        .join(' - ')
      if (!betsByType[b.betType]) betsByType[b.betType] = []
      betsByType[b.betType].push({ umabanCombo: b.umabanCombo, names, probability: b.probability })
    }
    for (const type of Object.keys(betsByType)) {
      betsByType[type].sort((a, b) => b.probability - a.probability)
    }

    const axisRow = axisByRace.get(r.raceId)
    let axisAnalysis: AxisAnalysis | null = null
    if (axisRow?.detailJson) {
      try {
        const detail = JSON.parse(axisRow.detailJson) as { breakdown: PredictionBreakdown; runningStyle: RunningStyle }
        axisAnalysis = {
          umaban: axisRow.umaban,
          horseName: axisRow.name,
          winProbability: axisRow.winProbability,
          runningStyle: detail.runningStyle,
          breakdown: detail.breakdown,
          summary: describeAxisPick(axisRow.name, axisRow.winProbability, detail.runningStyle, detail.breakdown),
        }
      } catch {
        axisAnalysis = null
      }
    }

    return {
      ...r,
      confidenceScore: r.probabilityGap != null ? confidenceScore(r.probabilityGap) : null,
      betsByType,
      axisAnalysis,
    }
  })
}

export type RaceDetailFinisher = { umaban: number; name: string; finishPosition: number | null }
export type RaceDetailBet = {
  umabanCombo: string
  names: string
  probability: number
  hit: boolean | null // null = 結果未確定
  payout: number | null // 100円/口あたりの払戻額(netkeiba発表値)
  stakeYen: number // このレースの予算(DEFAULT_BUDGET_YEN)を券種均等×確率比例で配分した想定購入額
}
export type RaceDetail = {
  raceId: string
  raceName: string
  course: string
  venue: string
  raceDate: string
  predictedAt: string
  confirmedAt: string | null
  finishOrder: RaceDetailFinisher[]
  betsByType: Record<string, RaceDetailBet[]>
  totalStakeYen: number
  totalPayout: number // 払戻合計(円)
  returnRate: number | null // 金額ベースの回収率(%)。結果未確定なら null
}

// 予想履歴の1レース分の詳細(買い目・実際の着順・的中結果)を返す。
// 回収率は /predict と同じ予算配分ロジック(券種に均等配分→券種内は確率比例、100円単位)で
// 実際に賭けたであろう金額をもとに計算する(100円均等ではない)。
export function getRaceDetail(raceId: string): RaceDetail | null {
  const race = db
    .prepare(
      `SELECT race_id as raceId, race_name as raceName, course, venue, race_date as raceDate,
              predicted_at as predictedAt, confirmed_at as confirmedAt
       FROM races WHERE race_id = ?`,
    )
    .get(raceId) as
    | {
        raceId: string
        raceName: string
        course: string
        venue: string
        raceDate: string
        predictedAt: string
        confirmedAt: string | null
      }
    | undefined
  if (!race) return null

  const predictions = db
    .prepare(
      `SELECT umaban, name, finish_position as finishPosition
       FROM predictions WHERE race_id = ?`,
    )
    .all(raceId) as { umaban: number; name: string; finishPosition: number | null }[]

  const nameByUmaban = new Map(predictions.map((p) => [p.umaban, p.name]))

  const finishOrder = predictions
    .filter((p) => p.finishPosition != null)
    .sort((a, b) => (a.finishPosition ?? 0) - (b.finishPosition ?? 0))

  const bets = db
    .prepare(
      `SELECT bet_type as betType, umaban_combo as umabanCombo, probability, hit, payout
       FROM bets WHERE race_id = ?`,
    )
    .all(raceId) as { betType: string; umabanCombo: string; probability: number; hit: number | null; payout: number | null }[]

  const grouped: Record<string, typeof bets> = {}
  for (const b of bets) {
    if (!grouped[b.betType]) grouped[b.betType] = []
    grouped[b.betType].push(b)
  }
  const stakesByType = allocateRaceStakes(
    Object.fromEntries(Object.entries(grouped).map(([t, arr]) => [t, arr.map((b) => ({ probability: b.probability }))])),
  )

  const betsByType: Record<string, RaceDetailBet[]> = {}
  let totalStakeYen = 0
  let totalPayout = 0
  for (const [betType, arr] of Object.entries(grouped)) {
    const stakes = stakesByType[betType] ?? arr.map(() => 0)
    betsByType[betType] = arr.map((b, i) => {
      const names = b.umabanCombo
        .split(',')
        .map((u) => nameByUmaban.get(Number(u)) ?? u)
        .join(' - ')
      const stakeYen = stakes[i] ?? 0
      if (race.confirmedAt) {
        totalStakeYen += stakeYen
        if (b.hit) totalPayout += Math.round((stakeYen / 100) * (b.payout ?? 0))
      }
      return {
        umabanCombo: b.umabanCombo,
        names,
        probability: b.probability,
        hit: b.hit == null ? null : !!b.hit,
        payout: b.payout,
        stakeYen,
      }
    })
    betsByType[betType].sort((a, b) => b.probability - a.probability)
  }

  return {
    ...race,
    finishOrder,
    betsByType,
    totalStakeYen,
    totalPayout,
    returnRate: race.confirmedAt && totalStakeYen > 0 ? Math.round((totalPayout / totalStakeYen) * 1000) / 10 : null,
  }
}

// 結果確定済みの全レースについて、/predict と同じ予算配分ロジックで
// 券種ごとの想定購入額・払戻額を計算する。getStats/getStatsByPeriod共通の下請け関数。
function computeConfirmedRaceMoneyStats(budget: number = DEFAULT_BUDGET_YEN) {
  const races = db
    .prepare(
      `SELECT race_id as raceId, COALESCE(race_date, substr(confirmed_at, 1, 10)) as day
       FROM races WHERE confirmed_at IS NOT NULL`,
    )
    .all() as { raceId: string; day: string }[]
  if (races.length === 0) return []

  const raceIds = races.map((r) => r.raceId)
  const placeholders = raceIds.map(() => '?').join(',')
  const allBets = db
    .prepare(
      `SELECT race_id as raceId, bet_type as betType, probability, hit, payout
       FROM bets WHERE race_id IN (${placeholders})`,
    )
    .all(...raceIds) as { raceId: string; betType: string; probability: number; hit: number | null; payout: number | null }[]

  const betsByRace = new Map<string, typeof allBets>()
  for (const b of allBets) {
    if (!betsByRace.has(b.raceId)) betsByRace.set(b.raceId, [])
    betsByRace.get(b.raceId)!.push(b)
  }

  return races.map((r) => {
    const bets = betsByRace.get(r.raceId) ?? []
    const grouped: Record<string, typeof bets> = {}
    for (const b of bets) {
      if (!grouped[b.betType]) grouped[b.betType] = []
      grouped[b.betType].push(b)
    }
    const stakesByType = allocateRaceStakes(
      Object.fromEntries(Object.entries(grouped).map(([t, arr]) => [t, arr.map((b) => ({ probability: b.probability }))])),
      budget,
    )

    const byType: Record<string, { attempts: number; hits: number; stake: number; returnYen: number }> = {}
    for (const [t, arr] of Object.entries(grouped)) {
      const stakes = stakesByType[t] ?? arr.map(() => 0)
      let attempts = 0
      let hits = 0
      let stake = 0
      let returnYen = 0
      arr.forEach((b, i) => {
        attempts += 1
        const s = stakes[i] ?? 0
        stake += s
        if (b.hit) {
          hits += 1
          returnYen += Math.round((s / 100) * (b.payout ?? 0))
        }
      })
      byType[t] = { attempts, hits, stake, returnYen }
    }
    return { raceId: r.raceId, period: r.day, byType }
  })
}

export type BetTypeStats = {
  betType: string
  attempts: number
  hits: number
  hitRate: number
  totalStakeYen: number
  totalPayout: number
  returnRate: number // totalPayout / totalStakeYen * 100(%)。予算配分ベースの金額回収率
}

export function getStats(): BetTypeStats[] {
  const perRace = computeConfirmedRaceMoneyStats()
  const agg = new Map<string, { attempts: number; hits: number; stake: number; returnYen: number }>()
  for (const race of perRace) {
    for (const [t, v] of Object.entries(race.byType)) {
      const cur = agg.get(t) ?? { attempts: 0, hits: 0, stake: 0, returnYen: 0 }
      cur.attempts += v.attempts
      cur.hits += v.hits
      cur.stake += v.stake
      cur.returnYen += v.returnYen
      agg.set(t, cur)
    }
  }

  return [...agg.entries()].map(([betType, v]) => ({
    betType,
    attempts: v.attempts,
    hits: v.hits,
    hitRate: v.attempts > 0 ? Math.round((v.hits / v.attempts) * 1000) / 10 : 0,
    totalStakeYen: v.stake,
    totalPayout: v.returnYen,
    returnRate: v.stake > 0 ? Math.round((v.returnYen / v.stake) * 1000) / 10 : 0,
  }))
}

export type StatsPeriodPoint = {
  period: string // 'day' なら YYYY-MM-DD、'month' なら YYYY-MM
  attempts: number
  hits: number
  totalStakeYen: number
  totalPayout: number
  returnRate: number // 当該期間単体の金額回収率(%)
  cumulativeReturnRate: number // 集計開始からの累積金額回収率(%)
}

// ダッシュボードの回収率推移グラフ用。race_date が無い古いレコードは confirmed_at の日付で代用する。
// /predict と同じ予算配分ロジックで実際に賭けたであろう金額をもとに回収率を計算する。
export function getStatsByPeriod(granularity: 'day' | 'month'): StatsPeriodPoint[] {
  const perRace = computeConfirmedRaceMoneyStats()
  const bucket = new Map<string, { attempts: number; hits: number; stake: number; returnYen: number }>()
  for (const race of perRace) {
    const period = granularity === 'month' ? race.period.slice(0, 7) : race.period
    const cur = bucket.get(period) ?? { attempts: 0, hits: 0, stake: 0, returnYen: 0 }
    for (const v of Object.values(race.byType)) {
      cur.attempts += v.attempts
      cur.hits += v.hits
      cur.stake += v.stake
      cur.returnYen += v.returnYen
    }
    bucket.set(period, cur)
  }

  const sortedPeriods = [...bucket.keys()].sort()
  let cumStake = 0
  let cumReturn = 0
  return sortedPeriods.map((period) => {
    const v = bucket.get(period)!
    cumStake += v.stake
    cumReturn += v.returnYen
    return {
      period,
      attempts: v.attempts,
      hits: v.hits,
      totalStakeYen: v.stake,
      totalPayout: v.returnYen,
      returnRate: v.stake > 0 ? Math.round((v.returnYen / v.stake) * 1000) / 10 : 0,
      cumulativeReturnRate: cumStake > 0 ? Math.round((cumReturn / cumStake) * 1000) / 10 : 0,
    }
  })
}
