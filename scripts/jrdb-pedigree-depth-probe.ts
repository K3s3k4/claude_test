// 「祖父母の個体名まで遡れるか」を実測する調査スクリプト。
// UKCには父・母・母父の3頭しか入っていないため、祖父母を得るには
// 「父馬自身のUKCレコードを馬名で探し、その父(=父父)・母(=父母)を読む」という自己参照チェーンが必要。
// このチェーンが実際に何%成立するのかを測定する(古い種牡馬・外国産はUKCに存在しないため欠損する)。
// 実行: npx tsx scripts/jrdb-pedigree-depth-probe.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseUkcBuffer, type UkcRow } from '../server/jrdbParser'

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
  const files = (await fs.readdir(dir)).filter((f) => /^UKC\d{6}\.txt$/.test(f)).sort()
  const latest = files[files.length - 1]
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

  console.log('\n【結論】')
  if (sireFound / targets.length < 0.2) {
    console.log('  父馬自身のUKCレコードがほとんど見つからない。')
    console.log('  理由: UKCは「その日に出走した馬」の集まりであり、種牡馬は既に引退していて')
    console.log('  現役期間(多くは2016年より前)が我々のアーカイブ範囲外のため。')
    console.log('  → 自己参照チェーンでは祖父母の個体名はほぼ取れない。')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
