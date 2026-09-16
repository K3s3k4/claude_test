// 血統系図の構築とインブリード(血統クロス)の検出。
//
// JRDBのUKC(馬基本データ)は1頭につき「父・母・母父」の3頭しか持たない。
// そのため祖父母以降は「父馬自身のUKCレコードを馬名で引く」自己参照チェーンで辿る必要がある。
// 例: ある馬の父父を知るには、父の馬名でUKCを検索し、そのレコードの父を読む。
// このチェーンは祖先自身がJRDBに収録されている(=日本で出走している)場合のみ成立するため、
// 世代を遡るほど欠損が増える。欠損は null として扱い、判明した範囲だけで分析する。
//
// インブリード(クロス)とは、同一の祖先が系図の複数箇所に現れること(例: ノーザンダンサー4×3)。
// 個々の祖先名を特徴量にすると種類が爆発してサンプルが分散するが、
// 「クロスの有無」「近親度の強さ」に圧縮すれば少数の特徴量に収まり、統計的に扱いやすい。

export type PedigreeRecord = { sire: string; dam: string; damSire: string }

/** 馬名 -> その馬の父・母・母父 の索引。UKC全ファイルから構築する。 */
export type PedigreeIndex = Map<string, PedigreeRecord>

/** 系図上の1頭。generation は対象馬から見た世代数(父・母=1、祖父母=2、...)。 */
export type Ancestor = { name: string; generation: number; path: string }

/**
 * 対象馬の祖先を、索引を辿れる範囲で maxGeneration 世代まで展開する。
 * path は 'S'(父)/'D'(母) の並びで系図上の位置を表す(例: 'SD' = 父の母)。
 */
export function buildAncestors(
  root: PedigreeRecord,
  index: PedigreeIndex,
  maxGeneration: number,
): Ancestor[] {
  const out: Ancestor[] = []
  // 1世代目は対象馬のレコードから直接得られる
  const queue: { name: string; generation: number; path: string }[] = []
  if (root.sire) queue.push({ name: root.sire, generation: 1, path: 'S' })
  if (root.dam) queue.push({ name: root.dam, generation: 1, path: 'D' })

  while (queue.length > 0) {
    const cur = queue.shift()!
    out.push(cur)
    if (cur.generation >= maxGeneration) continue

    const rec = index.get(cur.name)
    if (rec) {
      if (rec.sire) queue.push({ name: rec.sire, generation: cur.generation + 1, path: `${cur.path}S` })
      if (rec.dam) queue.push({ name: rec.dam, generation: cur.generation + 1, path: `${cur.path}D` })
    } else if (cur.path === 'D' && root.damSire) {
      // 母のレコードが引けなくても、母父だけはUKCに直接入っているので補完できる
      queue.push({ name: root.damSire, generation: cur.generation + 1, path: 'DS' })
    }
  }
  return out
}

export type Cross = {
  ancestor: string
  generations: number[] // 出現した世代(降順でない場合もあるので使用側でソートする)
  /** 表記用。例: [3,4] -> "4x3"(慣例として近い世代を右に書く) */
  label: string
  /** ライトの近交係数への寄与: Σ (0.5)^(m+n+1) */
  contribution: number
}

/**
 * 同一祖先が複数箇所に現れる(=クロスしている)ものを抽出する。
 * 同じ祖先が3箇所以上に現れる場合は、全ペアの寄与を合算する。
 */
export function detectCrosses(ancestors: Ancestor[]): Cross[] {
  const byName = new Map<string, number[]>()
  for (const a of ancestors) {
    if (!a.name) continue
    const list = byName.get(a.name) ?? []
    list.push(a.generation)
    byName.set(a.name, list)
  }

  const crosses: Cross[] = []
  for (const [ancestor, generations] of byName) {
    if (generations.length < 2) continue
    const sorted = [...generations].sort((a, b) => b - a) // 遠い世代から
    let contribution = 0
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        contribution += Math.pow(0.5, sorted[i] + sorted[j] + 1)
      }
    }
    crosses.push({
      ancestor,
      generations: sorted,
      label: sorted.join('x'),
      contribution,
    })
  }
  // 影響の大きい(=近い世代での)クロス順に並べる
  return crosses.sort((a, b) => b.contribution - a.contribution)
}

export type InbreedingSummary = {
  /** 展開できた祖先の延べ数(欠損を除く) */
  knownAncestors: number
  /** クロスしている祖先の数 */
  crossCount: number
  /** 近交係数(判明した範囲での近似値) */
  coefficient: number
  /** 最も影響の大きいクロス(無ければ null) */
  topCross: Cross | null
  /** 5世代以内で3代以内の濃いクロスがあるか */
  hasCloseCross: boolean
}

export function summarizeInbreeding(ancestors: Ancestor[]): InbreedingSummary {
  const crosses = detectCrosses(ancestors)
  const coefficient = crosses.reduce((s, c) => s + c.contribution, 0)
  const topCross = crosses[0] ?? null
  // 「濃いクロス」= 同じ祖先が3世代以内に2回以上現れる(例: 3x3, 2x4 など)
  const hasCloseCross = crosses.some((c) => c.generations.filter((g) => g <= 3).length >= 2)
  return {
    knownAncestors: ancestors.length,
    crossCount: crosses.length,
    coefficient,
    topCross,
    hasCloseCross,
  }
}
