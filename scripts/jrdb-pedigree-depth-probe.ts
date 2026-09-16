// 「祖父母の個体名まで遡れるか」を実測する調査スクリプト。
// UKCには父・母・母父の3頭しか入っていないため、祖父母を得るには
// 「父馬自身のUKCレコードを馬名で探し、その父(=父父)・母(=父母)を読む」という自己参照チェーンが必要。
// このチェーンが実際に何%成立するのかを測定する(古い種牡馬・外国産はUKCに存在しないため欠損する)。
// 実行: npx tsx scripts/jrdb-pedigree-depth-probe.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseUkcBuffer, jrdbFileDate, type UkcRow } from '../server/jrdbParser'
import { buildAncestors, summarizeInbreeding } from '../server/pedigree'

// UKCは1999年分まで存在するため、ファイル名の文字列ソートでは "UKC99..." が最後に来てしまう。
// 実日付に変換してから最新日を選ぶ。
function latestUkcFile(files: string[]): string {
  return files
    .map((f) => {
      const m = f.match(/^UKC(\d{2})(\d{2})(\d{2})\.txt$/)!
      return { f, date: jrdbFileDate(m[1], m[2], m[3]) }
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .at(-1)!.f
}

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

type Ped = { sire: string; dam: string; damSire: string }

async function buildNameIndex(): Promise<{ index: Map<string, Ped>; fileCount: number; horseCount: number }> {
  const dir = path.join(DATA_DIR, 'Ukc')
  const files = (await fs.readdir(dir)).filter((f) => /^UKC\d{6}\.txt$/.test(f)).sort()
  const index = new Map<string, Ped>()
  let horseCount = 0

  for (const f of files) {
    let rows: UkcRow[]
    try {
      rows = parseUkcBuffer(await fs.readFile(path.join(dir, f)))
    } catch {
      continue
    }
    for (const r of rows) {
      const name = str(r.horseName)
      if (!name) continue
      horseCount++
      // 同名は上書き(同一馬が複数日に出走するため重複は正常)
      index.set(name, { sire: str(r.sireName), dam: str(r.damName), damSire: str(r.damSireName) })
    }
  }
  return { index, fileCount: files.length, horseCount }
}

async function main() {
  console.log('=== 血統の到達可能世代を実測 ===\n')
  const { index, fileCount, horseCount } = await buildNameIndex()
  console.log(`UKCファイル${fileCount}件を読み込み、延べ${horseCount.toLocaleString()}頭 → ユニーク馬名${index.size.toLocaleString()}頭の索引を構築\n`)

  // 直近のUKCファイルに載っている馬(=現役馬)を対象に、何世代まで名前が取れるか測る
  const dir = path.join(DATA_DIR, 'Ukc')
  const files = (await fs.readdir(dir)).filter((f) => /^UKC\d{6}\.txt$/.test(f))
  const latest = latestUkcFile(files)
  const targets = parseUkcBuffer(await fs.readFile(path.join(dir, latest)))
  console.log(`対象(最新日 ${latest} の出走馬): ${targets.length}頭\n`)

  const lookup = (name: string): Ped | null => (name ? (index.get(name) ?? null) : null)

  let gen1 = 0 // 父・母(UKCに直接入っている)
  let damSireDirect = 0 // 母父(UKCに直接入っている)
  let sireSire = 0 // 父父(父のレコードを引けたら取れる)
  let sireDam = 0 // 父母
  let damDam = 0 // 母母(母のレコードを引けたら取れる)
  let gen3Any = 0 // 曾祖父母のどれか1つでも取れた数
  let sireFound = 0
  let damFound = 0

  for (const t of targets) {
    const sire = str(t.sireName)
    const dam = str(t.damName)
    const damSire = str(t.damSireName)
    if (sire && dam) gen1++
    if (damSire) damSireDirect++

    const sireRec = lookup(sire)
    if (sireRec) {
      sireFound++
      if (sireRec.sire) sireSire++
      if (sireRec.dam) sireDam++
      // 3世代目: 父父の父を引けるか
      const sireSireRec = lookup(sireRec.sire)
      if (sireSireRec?.sire) gen3Any++
    }
    const damRec = lookup(dam)
    if (damRec) {
      damFound++
      if (damRec.dam) damDam++
    }
  }

  const pct = (n: number) => `${((n / targets.length) * 100).toFixed(1)}%`
  console.log('【1世代目(UKCに直接収録)】')
  console.log(`  父・母:        ${gen1}頭 (${pct(gen1)})`)
  console.log('\n【2世代目(祖父母4頭)】')
  console.log(`  母父(直接収録): ${damSireDirect}頭 (${pct(damSireDirect)})  ← UKCにそのまま入っている`)
  console.log(`  父のUKCレコードが見つかった: ${sireFound}頭 (${pct(sireFound)})`)
  console.log(`    └ 父父が取れた:  ${sireSire}頭 (${pct(sireSire)})`)
  console.log(`    └ 父母が取れた:  ${sireDam}頭 (${pct(sireDam)})`)
  console.log(`  母のUKCレコードが見つかった: ${damFound}頭 (${pct(damFound)})`)
  console.log(`    └ 母母が取れた:  ${damDam}頭 (${pct(damDam)})`)
  console.log('\n【3世代目(曾祖父母8頭)】')
  console.log(`  父父の父が取れた: ${gen3Any}頭 (${pct(gen3Any)})`)

  // --- インブリード(クロス)が実際に何%検出できるか ---
  console.log('\n【インブリード検出の実現性】')
  const genKnown = [0, 0, 0, 0, 0, 0] // 各世代で判明した祖先の延べ数
  const genTheoretical = [0, 2, 4, 8, 16, 32]
  let withCross = 0
  let withCloseCross = 0
  let coefficientSum = 0
  const crossExamples: string[] = []

  for (const t of targets) {
    const root = { sire: str(t.sireName), dam: str(t.damName), damSire: str(t.damSireName) }
    const ancestors = buildAncestors(root, index, 5)
    for (const a of ancestors) {
      if (a.generation <= 5) genKnown[a.generation]++
    }
    const summary = summarizeInbreeding(ancestors)
    if (summary.crossCount > 0) {
      withCross++
      coefficientSum += summary.coefficient
      if (summary.topCross && crossExamples.length < 5) {
        crossExamples.push(`${str(t.horseName)}: ${summary.topCross.ancestor} ${summary.topCross.label}`)
      }
    }
    if (summary.hasCloseCross) withCloseCross++
  }

  for (let g = 1; g <= 5; g++) {
    const avg = genKnown[g] / targets.length
    console.log(`  ${g}世代目: 平均${avg.toFixed(1)}頭判明 / 理論${genTheoretical[g]}頭 (${((avg / genTheoretical[g]) * 100).toFixed(0)}%)`)
  }
  console.log(`  クロスが検出できた馬: ${withCross}頭 (${pct(withCross)})`)
  console.log(`  濃いクロス(3世代以内に2回)を持つ馬: ${withCloseCross}頭 (${pct(withCloseCross)})`)
  if (withCross > 0) {
    console.log(`  クロスありの馬の平均近交係数: ${((coefficientSum / withCross) * 100).toFixed(2)}%`)
    console.log(`  例: ${crossExamples.join(' / ')}`)
  }

  console.log('\n【結論】')
  if (withCross / targets.length < 0.15) {
    console.log('  クロスの検出率が低すぎるため、インブリードを特徴量にした分析は現時点では困難。')
    console.log('  深い世代の欠損が多く、実際にはクロスしていても検出できていない可能性が高い。')
  } else {
    console.log('  クロスが十分な割合で検出できており、インブリードを切り口にした分析が可能。')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
