// 予算配分ロジック。/predict画面の推奨買い目(Prediction.tsx)と全く同じアルゴリズムを
// サーバー側でも使い、過去レースの回収率を「100円均等」ではなく実際に賭けたであろう
// 金額ベースで再計算できるようにする。
export const STAKE_UNIT_YEN = 100
export const DEFAULT_BUDGET_YEN = 3000
export const BET_TYPE_ORDER = ['tansho', 'fukusho', 'umaren', 'wide', 'umatan', 'sanrenpuku', 'sanrentan'] as const

// 予算(円)を、重み(推定確率など)に比例して100円単位に丸めて配分する。
// 端数は最も重みが大きいものから順に100円ずつ割り振り、合計が予算とずれないようにする。
export function splitBudget(budget: number, weights: number[]): number[] {
  const flooredBudget = Math.floor(budget / STAKE_UNIT_YEN) * STAKE_UNIT_YEN
  const totalWeight = weights.reduce((s, w) => s + w, 0)
  if (flooredBudget <= 0 || totalWeight <= 0 || weights.length === 0) return weights.map(() => 0)

  const raw = weights.map((w) => (flooredBudget * w) / totalWeight)
  const rounded = raw.map((v) => Math.floor(v / STAKE_UNIT_YEN) * STAKE_UNIT_YEN)
  let remainder = flooredBudget - rounded.reduce((s, v) => s + v, 0)

  const order = weights.map((_, i) => i).sort((a, b) => weights[b] - weights[a])
  let i = 0
  while (remainder >= STAKE_UNIT_YEN && order.length > 0) {
    rounded[order[i % order.length]] += STAKE_UNIT_YEN
    remainder -= STAKE_UNIT_YEN
    i++
  }
  return rounded
}

// 1レース分の買い目(券種ごとにグループ化)に対して、予算を券種に均等配分し、
// 券種内は推定確率に比例して配分する。/predict画面のデフォルト配分方式と同じ。
export function allocateRaceStakes(
  betsByType: Record<string, { probability: number }[]>,
  budget: number = DEFAULT_BUDGET_YEN,
): Record<string, number[]> {
  const activeTypes = BET_TYPE_ORDER.filter((t) => betsByType[t]?.length)
  const perType = splitBudget(
    budget,
    activeTypes.map(() => 1),
  )
  const result: Record<string, number[]> = {}
  activeTypes.forEach((t, i) => {
    result[t] = splitBudget(
      perType[i],
      betsByType[t].map((b) => b.probability),
    )
  })
  return result
}
