// JRDBの過去データを日付を遡って一括ダウンロードするスクリプト。
// 実行例: npx tsx scripts/jrdb-bulk-download.ts --days 1095 --types Kyi,Sed
//
// 既に展開済みのファイルはスキップするため、途中で止めても再実行すれば続きから進む。
import 'dotenv/config'
import { downloadJrdbFile, jitteredSleep, JrdbAuthError, type JrdbFileType } from '../server/jrdb'

function parseArgs() {
  const args = process.argv.slice(2)
  let days = 1095
  let types: JrdbFileType[] = ['Kyi', 'Sed']
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days') days = Number(args[++i])
    if (args[i] === '--types') types = args[++i].split(',') as JrdbFileType[]
  }
  return { days, types }
}

async function main() {
  const { days, types } = parseArgs()
  console.log(`JRDB一括ダウンロード開始: 過去${days}日分, 種別=${types.join(',')}`)

  const today = new Date()
  let found = 0
  let skippedNoData = 0
  let failed = 0
  const startedAt = Date.now()

  for (let offset = 1; offset <= days; offset++) {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)

    for (const type of types) {
      try {
        const files = await downloadJrdbFile(type, date)
        if (files) {
          found++
        } else {
          skippedNoData++
        }
      } catch (err) {
        if (err instanceof JrdbAuthError) {
          console.error(`認証エラーのため中断します: ${err.message}`)
          process.exit(1)
        }
        failed++
        console.error(`失敗 [${type} ${date.toISOString().slice(0, 10)}]: ${err instanceof Error ? err.message : err}`)
      }
      await jitteredSleep(600, 1400)
    }

    if (offset % 30 === 0) {
      const elapsedMin = Math.round((Date.now() - startedAt) / 60000)
      console.log(`進捗: ${offset}/${days}日処理済み (取得${found} / データなし${skippedNoData} / 失敗${failed}) 経過${elapsedMin}分`)
    }
  }

  console.log(`完了: 取得${found} / データなし${skippedNoData} / 失敗${failed}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
