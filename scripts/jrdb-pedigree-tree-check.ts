// 血統系図の展開とインブリード検出が正しく動くかを、実在の馬で目視確認するスクリプト。
// 実行: npx tsx scripts/jrdb-pedigree-tree-check.ts [確認したい頭数]
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseUkcBuffer, jrdbFileDate, type UkcRow } from '../server/jrdbParser'
import { buildAncestors, detectCrosses, summarizeInbreeding, type PedigreeIndex } from '../server/pedigree'

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
const SAMPLE = Number(process.argv[2]) || 5
const MAX_GEN = 5

async function buildIndex(): Promise<{ index: PedigreeIndex; files: number }> {
  const dir = path.join(DATA_DIR, 'Ukc')
  const files = (await fs.readdir(dir)).filter((f) => /^UKC\d{6}\.txt$/.test(f)).sort()
  const index: PedigreeIndex = new Map()
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
      index.set(name, { sire: str(r.sireName), dam: str(r.damName), damSire: str(r.damSireName) })
    }
  }
  return { index, files: files.length }
}

async function main() {
  const { index, files } = await buildIndex()
  console.log(`UKC ${files}ファイルから ${index.size.toLocaleString()}頭の血統索引を構築\n`)

  const dir = path.join(DATA_DIR, 'Ukc')
  const ukcFiles = (await fs.readdir(dir)).filter((f) => /^UKC\d{6}\.txt$/.test(f))
  const latest = latestUkcFile(ukcFiles)
  console.log(`対象: ${latest} の出走馬から${SAMPLE}頭\n`)
  const targets = parseUkcBuffer(await fs.readFile(path.join(dir, latest))).slice(0, SAMPLE)

  for (const t of targets) {
    const root = { sire: str(t.sireName), dam: str(t.damName), damSire: str(t.damSireName) }
    const ancestors = buildAncestors(root, index, MAX_GEN)
    const summary = summarizeInbreeding(ancestors)
    const crosses = detectCrosses(ancestors)

    console.log(`■ ${str(t.horseName)}`)
    console.log(`  父: ${root.sire} / 母: ${root.dam} / 母父: ${root.damSire}`)

    const byGen = new Map<number, string[]>()
    for (const a of ancestors) {
      const list = byGen.get(a.generation) ?? []
      list.push(`${a.path}:${a.name}`)
      byGen.set(a.generation, list)
    }
    for (let g = 1; g <= MAX_GEN; g++) {
      const list = byGen.get(g)
      if (!list || list.length === 0) continue
      // 2の g 乗が理論上の最大頭数
      console.log(`  ${g}世代目(理論${Math.pow(2, g)}頭中${list.length}頭判明): ${list.slice(0, 8).join(', ')}${list.length > 8 ? ' ...' : ''}`)
    }
    if (crosses.length > 0) {
      console.log(`  ★インブリード: ${crosses.map((c) => `${c.ancestor} ${c.label}`).join(' / ')}`)
      console.log(`   近交係数(判明範囲): ${(summary.coefficient * 100).toFixed(2)}%  濃いクロス: ${summary.hasCloseCross ? 'あり' : 'なし'}`)
    } else {
      console.log('  インブリード: 検出なし(または系図の欠損により判定不能)')
    }
    console.log('')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
