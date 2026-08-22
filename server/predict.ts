import type { RaceCard, RaceCardHorse, PastRace, Pedigree } from './netkeiba'

// 実績のある種牡馬・母父を簡易的にランク付け（0-100）。リストにない場合は中立点。
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
}

function ratePedigreeName(name: string): number {
  return SIRE_RATING[name] ?? 50
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

function conditionScore(horse: RaceCardHorse): number {
  const diff = horse.horseWeightDiff ?? 0
  const abs = Math.abs(diff)
  if (abs <= 6) return 80
  if (abs <= 10) return 65
  if (abs <= 16) return 45
  return 25
}

function pedigreeScore(pedigree: Pedigree): number {
  const sireScore = ratePedigreeName(pedigree.sire)
  const damSireScore = ratePedigreeName(pedigree.damSire)
  return sireScore * 0.7 + damSireScore * 0.3
}

function marketScore(horse: RaceCardHorse): number {
  if (!horse.popularity) return 50
  return Math.max(20, 100 - (horse.popularity - 1) * 8)
}

export type PredictionBreakdown = {
  recentForm: number
  distanceAptitude: number
  surfaceAptitude: number
  condition: number
  pedigree: number
  market: number
}

export type HorsePrediction = {
  horse: RaceCardHorse
  pedigree: Pedigree
  score: number
  breakdown: PredictionBreakdown
  rank: number
}

const WEIGHTS = {
  recentForm: 0.3,
  distanceAptitude: 0.2,
  surfaceAptitude: 0.15,
  condition: 0.1,
  pedigree: 0.15,
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
    condition: conditionScore(horse),
    pedigree: pedigreeScore(pedigree),
    market: marketScore(horse),
  }

  const score =
    breakdown.recentForm * WEIGHTS.recentForm +
    breakdown.distanceAptitude * WEIGHTS.distanceAptitude +
    breakdown.surfaceAptitude * WEIGHTS.surfaceAptitude +
    breakdown.condition * WEIGHTS.condition +
    breakdown.pedigree * WEIGHTS.pedigree +
    breakdown.market * WEIGHTS.market

  return { horse, pedigree, score: Math.round(score * 10) / 10, breakdown }
}

export function rankPredictions(predictions: Omit<HorsePrediction, 'rank'>[]): HorsePrediction[] {
  return [...predictions]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }))
}
