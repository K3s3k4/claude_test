import Database from 'better-sqlite3'
import path from 'node:path'
import type { RaceCard, PastRace, Pedigree } from './netkeiba'
import type { RaceResult } from './netkeiba'
import type { HorsePrediction, BetSuggestions, PredictionBreakdown, RunningStyle } from './predict'
import { confidenceScore, describeAxisPick } from './predict'

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
  payout: number | null
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
  totalAttempts: number
  totalPayout: number
  returnRate: number | null // 結果未確定なら null
}

// 予想履歴の1レース分の詳細(買い目・実際の着順・的中結果)を返す
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

  const betsByType: Record<string, RaceDetailBet[]> = {}
  let totalAttempts = 0
  let totalPayout = 0
  for (const b of bets) {
    const names = b.umabanCombo
      .split(',')
      .map((u) => nameByUmaban.get(Number(u)) ?? u)
      .join(' - ')
    if (!betsByType[b.betType]) betsByType[b.betType] = []
    betsByType[b.betType].push({
      umabanCombo: b.umabanCombo,
      names,
      probability: b.probability,
      hit: b.hit == null ? null : !!b.hit,
      payout: b.payout,
    })
    if (race.confirmedAt) {
      totalAttempts += 1
      totalPayout += b.payout ?? 0
    }
  }
  for (const type of Object.keys(betsByType)) {
    betsByType[type].sort((a, b) => b.probability - a.probability)
  }

  return {
    ...race,
    finishOrder,
    betsByType,
    totalAttempts,
    totalPayout,
    returnRate: race.confirmedAt && totalAttempts > 0 ? Math.round((totalPayout / (totalAttempts * 100)) * 1000) / 10 : null,
  }
}

export type BetTypeStats = {
  betType: string
  attempts: number
  hits: number
  hitRate: number
  totalPayout: number
  returnRate: number // totalPayout / (attempts * 100点単位) * 100(%)
}

export function getStats(): BetTypeStats[] {
  const rows = db
    .prepare(
      `SELECT b.bet_type as betType,
              COUNT(*) as attempts,
              SUM(CASE WHEN b.hit = 1 THEN 1 ELSE 0 END) as hits,
              SUM(COALESCE(b.payout, 0)) as totalPayout
       FROM bets b
       JOIN races r ON r.race_id = b.race_id
       WHERE r.confirmed_at IS NOT NULL
       GROUP BY b.bet_type`,
    )
    .all() as { betType: string; attempts: number; hits: number; totalPayout: number }[]

  return rows.map((r) => ({
    betType: r.betType,
    attempts: r.attempts,
    hits: r.hits,
    hitRate: r.attempts > 0 ? Math.round((r.hits / r.attempts) * 1000) / 10 : 0,
    totalPayout: r.totalPayout,
    returnRate: r.attempts > 0 ? Math.round((r.totalPayout / (r.attempts * 100)) * 1000) / 10 : 0,
  }))
}

export type StatsPeriodPoint = {
  period: string // 'day' なら YYYY-MM-DD、'month' なら YYYY-MM
  attempts: number
  hits: number
  totalPayout: number
  returnRate: number // 当該期間単体の回収率(%)
  cumulativeReturnRate: number // 集計開始からの累積回収率(%)
}

// ダッシュボードの回収率推移グラフ用。race_date が無い古いレコードは confirmed_at の日付で代用する。
export function getStatsByPeriod(granularity: 'day' | 'month'): StatsPeriodPoint[] {
  const periodExpr =
    granularity === 'month'
      ? "substr(COALESCE(r.race_date, substr(r.confirmed_at, 1, 10)), 1, 7)"
      : "COALESCE(r.race_date, substr(r.confirmed_at, 1, 10))"

  const rows = db
    .prepare(
      `SELECT ${periodExpr} as period,
              COUNT(*) as attempts,
              SUM(CASE WHEN b.hit = 1 THEN 1 ELSE 0 END) as hits,
              SUM(COALESCE(b.payout, 0)) as totalPayout
       FROM bets b
       JOIN races r ON r.race_id = b.race_id
       WHERE r.confirmed_at IS NOT NULL
       GROUP BY period
       ORDER BY period ASC`,
    )
    .all() as { period: string; attempts: number; hits: number; totalPayout: number }[]

  let cumAttempts = 0
  let cumPayout = 0
  return rows.map((r) => {
    cumAttempts += r.attempts
    cumPayout += r.totalPayout
    return {
      period: r.period,
      attempts: r.attempts,
      hits: r.hits,
      totalPayout: r.totalPayout,
      returnRate: r.attempts > 0 ? Math.round((r.totalPayout / (r.attempts * 100)) * 1000) / 10 : 0,
      cumulativeReturnRate: cumAttempts > 0 ? Math.round((cumPayout / (cumAttempts * 100)) * 1000) / 10 : 0,
    }
  })
}
