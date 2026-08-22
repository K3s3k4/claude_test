// 確率論・数理モデル関連のユーティリティ
//
// 前提として、以下のtemperature(softmax)・shrinkage定数k は実際のレース結果を
// 使ったバックテスト・キャリブレーションを行っていない暫定値です。
// 過去データでの検証を行うまでは、あくまで「相対的な目安」として扱ってください。

// スコア配列(0-100点)を、合計100%になる推定勝率に変換する(softmax)。
// temperatureが大きいほど確率が均される(差が出にくくなる)。
export function softmaxProbabilities(scores: number[], temperature = 10): number[] {
  if (scores.length === 0) return []
  const max = Math.max(...scores)
  const exps = scores.map((s) => Math.exp((s - max) / temperature))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map((e) => e / sum)
}

// 経験ベイズ(Empirical Bayes)によるサンプル数補正。
// サンプル数が少ないほど、観測値ではなく事前平均(prior)に近づける。
// k はどれだけ強く補正するかの定数(kレース分の"仮想サンプル"を事前分布に足すイメージ)。
export function empiricalBayesShrink(observed: number, sampleSize: number, prior: number, k = 3): number {
  if (sampleSize <= 0) return prior
  return (sampleSize / (sampleSize + k)) * observed + (k / (sampleSize + k)) * prior
}

// Harvilleモデル: 「1着=probs[0]の馬、2着=probs[1]の馬、...」という
// 完全に順序を固定した着順の実現確率を、勝率の連鎖(条件付き確率)から求める。
// P(1着=A,2着=B,3着=C) = P(A) * P(B)/(1-P(A)) * P(C)/(1-P(A)-P(B))
export function harvilleOrderProbability(orderedProbs: number[]): number {
  let remaining = 1
  let result = 1
  for (const p of orderedProbs) {
    if (remaining <= 1e-9) return 0
    result *= p / remaining
    remaining -= p
  }
  return Math.max(0, result)
}

// 馬単(着順固定2頭)の確率
export function exactaProbability(pFirst: number, pSecond: number): number {
  return harvilleOrderProbability([pFirst, pSecond])
}

// 馬連(着順不問2頭)の確率
export function quinellaProbability(pA: number, pB: number): number {
  return exactaProbability(pA, pB) + exactaProbability(pB, pA)
}

// 三連単(着順固定3頭)の確率
export function trifectaOrderProbability(pFirst: number, pSecond: number, pThird: number): number {
  return harvilleOrderProbability([pFirst, pSecond, pThird])
}

// 三連複(着順不問3頭、上位3着が指定の3頭になる確率)
export function trioSetProbability(pA: number, pB: number, pC: number): number {
  const perms: [number, number, number][] = [
    [pA, pB, pC],
    [pA, pC, pB],
    [pB, pA, pC],
    [pB, pC, pA],
    [pC, pA, pB],
    [pC, pB, pA],
  ]
  return perms.reduce((sum, order) => sum + harvilleOrderProbability(order), 0)
}

// 指定インデックスの馬が3着以内に入る確率(複勝的中確率)
// フィールド全馬の勝率配列(合計1になるもの)が必要
export function placeProbability(index: number, allProbs: number[]): number {
  const p = allProbs[index]
  const others = allProbs.filter((_, i) => i !== index)

  let secondProb = 0
  for (const pFirst of others) {
    secondProb += exactaProbability(pFirst, p)
  }

  let thirdProb = 0
  for (let i = 0; i < others.length; i++) {
    for (let j = 0; j < others.length; j++) {
      if (i === j) continue
      thirdProb += trifectaOrderProbability(others[i], others[j], p)
    }
  }

  return p + secondProb + thirdProb
}

// 指定2頭がともに3着以内に入る確率(ワイド的中確率)
export function wideProbability(indexA: number, indexB: number, allProbs: number[]): number {
  const pA = allProbs[indexA]
  const pB = allProbs[indexB]
  let total = 0
  for (let i = 0; i < allProbs.length; i++) {
    if (i === indexA || i === indexB) continue
    total += trioSetProbability(pA, pB, allProbs[i])
  }
  return total
}

// 期待値(EV) = 推定的中確率 × オッズ。1を超えると理論上プラス期待値。
export function expectedValue(probability: number, odds: number | null): number | null {
  if (odds == null) return null
  return Math.round(probability * odds * 100) / 100
}
