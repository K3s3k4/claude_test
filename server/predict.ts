import type { RaceCard, RaceCardHorse, PastRace, Pedigree } from './netkeiba'

// 実績のある種牡馬・母父を簡易的にランク付け(0-100)。リストにない場合は中立点(50)。
// 本格的な血統統計DBの代替として、著名な種牡馬を手動でスコアリングしている簡易版。
const SIRE_RATING: Record<string, number> = {
  ディープインパクト: 95,
  キズナ: 90,
  ロードカナロア: 92,
  ハーツクライ: 85,
  エピファネイア: 88,
  ドゥラメンテ: 87,
  キングカメハメハ: 90,
  ダイワメジャー: 80,
  オルフェーヴル: 82,
  モーリス: 86,
  サンデーサイレンス: 98,
  Halo: 75,
  Alzao: 70,
  マンハッタンカフェ: 75,
  ステイゴールド: 83,
  シンボリクリスエス: 78,
  トニービン: 80,
  ノーザンテースト: 78,
  ミスタープロスペクター: 82,
  ノーザンダンサー: 90,
  'Hail to Reason': 65,
  'Nijinsky': 75,
}

function ratePedigreeName(name: string): number {
  return SIRE_RATING[name] ?? 50
}

// 3世代分の血統を、直系に近いほど重みを大きくして加重平均する
const PEDIGREE_WEIGHTS: [keyof Pedigree, number][] = [
  ['sire', 3],
  ['dam', 1.2],
  ['sireSire', 1.5],
  ['damSire', 1.8], // 母父(damsire)は日本の血統理論で特に重視される
  ['sireDam', 0.8],
  ['damDam', 0.8],
  ['sireSireSire', 0.5],
  ['sireSireDam', 0.3],
  ['sireDamSire', 0.5],
  ['sireDamDam', 0.3],
  ['damSireSire', 0.5],
  ['damSireDam', 0.3],
  ['damDamSire', 0.5],
  ['damDamDam', 0.3],
]

function pedigreeScore(pedigree: Pedigree): number {
  let sum = 0
  let weightSum = 0
  for (const [key, weight] of PEDIGREE_WEIGHTS) {
    const name = pedigree[key]
    if (!name) continue
    sum += ratePedigreeName(name) * weight
    weightSum += weight
  }
  if (weightSum === 0) return 50
  return sum / weightSum
}

function finishScore(pos: number | null, fieldSize: number | null): number {
  if (pos == null) return 40 // 出走はしたが着順不明(中止・除外など)
  if (pos === 1) return 100
  if (pos === 2) return 82
  if (pos === 3) return 68
  const size = fieldSize ?? 16
  const rest = Math.max(0, 1 - (pos - 3) / Math.max(size - 3, 1))
  return Math.round(55 * rest)
}

function recentFormScore(history: PastRace[]): number {
  const recent = history.slice(0, 5)
  if (recent.length === 0) return 45
  const weights = [1.5, 1.2, 1.0, 0.8, 0.6]
  let sum = 0
  let weightSum = 0
  recent.forEach((race, i) => {
    const w = weights[i] ?? 0.5
    sum += finishScore(race.finishPosition, race.fieldSize) * w
    weightSum += w
  })
  return sum / weightSum
}

function distanceAptitudeScore(history: PastRace[], targetDistance: number): number {
  const inRange = history.filter((r) => Math.abs(r.distance - targetDistance) <= 400 && r.distance > 0)
  if (inRange.length === 0) return recentFormScore(history) * 0.7
  const avg =
    inRange.reduce((s, r) => s + finishScore(r.finishPosition, r.fieldSize), 0) / inRange.length
  return avg
}

function surfaceAptitudeScore(history: PastRace[], targetSurface: RaceCard['surface']): number {
  if (targetSurface === 'unknown') return 50
  const sameSurface = history.filter((r) => r.surface === targetSurface)
  if (sameSurface.length === 0) return 50
  const avg =
    sameSurface.reduce((s, r) => s + finishScore(r.finishPosition, r.fieldSize), 0) /
    sameSurface.length
  return avg
}

// 馬場状態(良/稍重/重/不良)ごとの適性
function trackConditionAptitudeScore(history: PastRace[], targetCondition: string): number {
  if (!targetCondition) return 50
  const matches = history.filter((r) => r.trackCondition === targetCondition)
  if (matches.length === 0) return recentFormScore(history) * 0.85
  const avg =
    matches.reduce((s, r) => s + finishScore(r.finishPosition, r.fieldSize), 0) / matches.length
  return avg
}

function conditionScore(horse: RaceCardHorse): number {
  const diff = horse.horseWeightDiff ?? 0
  const abs = Math.abs(diff)
  if (abs <= 6) return 80
  if (abs <= 10) return 65
  if (abs <= 16) return 45
  return 25
}

function marketScore(horse: RaceCardHorse): number {
  if (!horse.popularity) return 50
  return Math.max(20, 100 - (horse.popularity - 1) * 8)
}

// レース名から級別(クラス)を推定する。数字が大きいほど格上のレース。
const CLASS_PATTERNS: [RegExp, number][] = [
  [/\(GIII\)|\(G3\)/, 6],
  [/\(GII\)|\(G2\)/, 7],
  [/\(GI\)|\(G1\)/, 8],
  [/\(L\)/, 5],
  [/オープン|\bOP\b/, 5],
  [/3勝クラス|1600万下/, 4],
  [/2勝クラス|1000万下/, 3],
  [/1勝クラス|500万下/, 2],
  [/未勝利|新馬/, 1],
]

function raceClassRank(raceName: string): number {
  for (const [pattern, rank] of CLASS_PATTERNS) {
    if (pattern.test(raceName)) return rank
  }
  return 0 // 不明
}

// 今回のレースの格に対して、過去にどのレベルまで実績があるかを評価する
function classAdequacyScore(history: PastRace[], currentRaceName: string): number {
  const targetRank = raceClassRank(currentRaceName)
  if (targetRank === 0) return 50

  let highestRankRun = 0
  let highestRankPlaced = 0
  for (const race of history) {
    const rank = raceClassRank(race.raceName)
    if (rank === 0) continue
    if (rank > highestRankRun) highestRankRun = rank
    if (rank > highestRankPlaced && race.finishPosition != null && race.finishPosition <= 3) {
      highestRankPlaced = rank
    }
  }

  if (highestRankPlaced >= targetRank) return 90
  if (highestRankRun >= targetRank) return 65
  if (highestRankRun === targetRank - 1) return 55
  return 35
}

// 同じ騎手が継続して騎乗しているか、その騎手との相性
function jockeyContinuityScore(history: PastRace[], currentJockey: string): number {
  if (!currentJockey) return 50
  const matches = history.filter((r) => r.jockey === currentJockey)
  if (matches.length === 0) return 50
  const avg = matches.reduce((s, r) => s + finishScore(r.finishPosition, r.fieldSize), 0) / matches.length
  const continuityBonus = history[0]?.jockey === currentJockey ? 5 : 0
  return Math.min(100, avg + continuityBonus)
}

export type RunningStyle = '逃げ' | '先行' | '差し' | '追込' | '不明'

// 通過順位(コーナー通過順)から脚質を推定する。あくまで参考情報でスコアには含めない。
export function estimateRunningStyle(history: PastRace[]): RunningStyle {
  const ratios: number[] = []
  for (const race of history.slice(0, 5)) {
    if (!race.passingPositions || !race.fieldSize) continue
    const first = Number(race.passingPositions.split('-')[0])
    if (!first || !race.fieldSize) continue
    ratios.push(first / race.fieldSize)
  }
  if (ratios.length === 0) return '不明'
  const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length
  if (avg <= 0.25) return '逃げ'
  if (avg <= 0.5) return '先行'
  if (avg <= 0.75) return '差し'
  return '追込'
}

export type PredictionBreakdown = {
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

export type HorsePrediction = {
  horse: RaceCardHorse
  pedigree: Pedigree
  runningStyle: RunningStyle
  score: number
  breakdown: PredictionBreakdown
  rank: number
}

const WEIGHTS: Record<keyof PredictionBreakdown, number> = {
  recentForm: 0.2,
  distanceAptitude: 0.13,
  surfaceAptitude: 0.08,
  trackConditionAptitude: 0.07,
  classAdequacy: 0.12,
  jockeyContinuity: 0.05,
  condition: 0.08,
  pedigree: 0.17,
  market: 0.1,
}

export function scoreHorse(
  race: RaceCard,
  horse: RaceCardHorse,
  history: PastRace[],
  pedigree: Pedigree,
): Omit<HorsePrediction, 'rank'> {
  const breakdown: PredictionBreakdown = {
    recentForm: recentFormScore(history),
    distanceAptitude: distanceAptitudeScore(history, race.distance),
    surfaceAptitude: surfaceAptitudeScore(history, race.surface),
    trackConditionAptitude: trackConditionAptitudeScore(history, race.trackCondition),
    classAdequacy: classAdequacyScore(history, race.raceName),
    jockeyContinuity: jockeyContinuityScore(history, horse.jockey),
    condition: conditionScore(horse),
    pedigree: pedigreeScore(pedigree),
    market: marketScore(horse),
  }

  const score = (Object.keys(WEIGHTS) as (keyof PredictionBreakdown)[]).reduce(
    (s, key) => s + breakdown[key] * WEIGHTS[key],
    0,
  )

  return {
    horse,
    pedigree,
    runningStyle: estimateRunningStyle(history),
    score: Math.round(score * 10) / 10,
    breakdown,
  }
}

export function rankPredictions(predictions: Omit<HorsePrediction, 'rank'>[]): HorsePrediction[] {
  return [...predictions]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }))
}

// --- 買い目推奨 ---

type Pick = { umaban: number; name: string }

export type BetSuggestions = {
  confidence: '堅い' | 'やや堅い' | '混戦'
  scoreGap: number // 1位と2位のスコア差
  boxSize: number // 軸+ヒモとして採用した頭数
  tansho: Pick[] // 単勝
  fukusho: Pick[] // 複勝
  umaren: [Pick, Pick][] // 馬連(BOX)
  wide: [Pick, Pick][] // ワイド(BOX)
  umatan: [Pick, Pick][] // 馬単(1着軸流し)
  sanrenpuku: [Pick, Pick, Pick][] // 三連複(BOX)
  sanrentan: [Pick, Pick, Pick][] // 三連単(1着軸2-3着流し)
}

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]]
  if (arr.length < k) return []
  const [head, ...rest] = arr
  const withHead = combinations(rest, k - 1).map((c) => [head, ...c])
  const withoutHead = combinations(rest, k)
  return [...withHead, ...withoutHead]
}

function permutations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]]
  const result: T[][] = []
  arr.forEach((item, i) => {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
    for (const p of permutations(rest, k - 1)) {
      result.push([item, ...p])
    }
  })
  return result
}

export function suggestBets(ranked: HorsePrediction[]): BetSuggestions | null {
  if (ranked.length < 3) return null

  const toPick = (p: HorsePrediction): Pick => ({ umaban: p.horse.umaban, name: p.horse.name })
  const scoreGap = Math.round((ranked[0].score - ranked[1].score) * 10) / 10

  let confidence: BetSuggestions['confidence']
  let boxSize: number
  if (scoreGap >= 8) {
    confidence = '堅い'
    boxSize = 3
  } else if (scoreGap >= 4) {
    confidence = 'やや堅い'
    boxSize = 4
  } else {
    confidence = '混戦'
    boxSize = 5
  }
  boxSize = Math.min(boxSize, ranked.length)

  const box = ranked.slice(0, boxSize).map(toPick)
  const axis = box[0]
  const flowTargets = box.slice(1)

  const umaren = combinations(box, 2) as [Pick, Pick][]
  const wide = umaren
  const sanrenpuku = boxSize >= 3 ? (combinations(box, 3) as [Pick, Pick, Pick][]) : []
  const umatan: [Pick, Pick][] = flowTargets.map((t) => [axis, t])
  const sanrentan: [Pick, Pick, Pick][] =
    flowTargets.length >= 2
      ? (permutations(flowTargets, 2).map(([a, b]) => [axis, a, b]) as [Pick, Pick, Pick][])
      : []

  return {
    confidence,
    scoreGap,
    boxSize,
    tansho: [toPick(ranked[0])],
    fukusho: ranked.slice(0, Math.min(3, boxSize)).map(toPick),
    umaren,
    wide,
    umatan,
    sanrenpuku,
    sanrentan,
  }
}
