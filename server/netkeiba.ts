import axios from 'axios'
import * as cheerio from 'cheerio'
import iconv from 'iconv-lite'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// netkeibaはEUC-JPで配信されるページが多いため、バイナリ取得してデコードする
async function fetchHtml(url: string, params?: Record<string, string>) {
  const res = await axios.get<ArrayBuffer>(url, {
    params,
    headers: { 'User-Agent': UA },
    responseType: 'arraybuffer',
    timeout: 15000,
  })
  const buf = Buffer.from(res.data)
  // UTF-8として妥当ならそのまま、そうでなければEUC-JPとして解釈する
  const utf8 = buf.toString('utf-8')
  if (!utf8.includes('�')) return utf8
  return iconv.decode(buf, 'euc-jp')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// 固定間隔だと機械的なアクセスに見えやすいため、範囲内でランダムな待機時間にする
function jitteredSleep(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs)
  return sleep(ms)
}

export type RaceCardHorse = {
  horseId: string
  waku: number
  umaban: number
  name: string
  sexAge: string
  weightCarried: number
  jockey: string
  trainer: string
  horseWeight: number | null
  horseWeightDiff: number | null
  odds: number | null
  popularity: number | null
}

export type RaceCard = {
  raceId: string
  raceName: string
  course: string
  distance: number
  surface: 'turf' | 'dirt' | 'unknown'
  trackCondition: string
  horses: RaceCardHorse[]
}

export async function fetchRaceCard(raceId: string): Promise<RaceCard> {
  const html = await fetchHtml('https://race.netkeiba.com/race/shutuba.html', { race_id: raceId })
  const $ = cheerio.load(html)

  const raceName = $('.RaceName').first().text().trim() || $('title').text().trim()
  const raceData01 = $('.RaceData01').first().text().replace(/\s+/g, ' ').trim()
  const distMatch = raceData01.match(/(\d{3,5})m/)
  const distance = distMatch ? Number(distMatch[1]) : 0
  const surface: RaceCard['surface'] = raceData01.includes('ダ')
    ? 'dirt'
    : raceData01.includes('芝')
      ? 'turf'
      : 'unknown'
  const conditionMatch = raceData01.match(/馬場:(\S+)/)
  const trackCondition = conditionMatch ? conditionMatch[1] : ''

  const horses: RaceCardHorse[] = []
  $('tr.HorseList').each((_, el) => {
    const row = $(el)
    const link = row.find('.HorseInfo a').first()
    const href = link.attr('href') || ''
    const idMatch = href.match(/horse\/(\d+)/)
    if (!idMatch) return

    const wakuText = row.find('[class*="Waku"]').first().text().trim()
    const umabanText = row.find('[class*="Umaban"]').first().text().trim()
    const sexAge = row.find('.Barei').text().trim()
    const weightCarried = Number(row.find('.Barei').next().text().trim()) || 0
    const jockey = row.find('.Jockey a').first().text().trim()
    const trainer = row.find('.Trainer a').first().text().trim()

    const weightText = row.find('.Weight').text().replace(/\s+/g, '')
    const weightMatch = weightText.match(/^(\d+)\(([+-]?\d+)\)/)

    const oddsText = row.find('[id^="odds-"]').first().text().trim()
    const ninkiText = row.find('[id^="ninki-"]').first().text().trim()

    horses.push({
      horseId: idMatch[1],
      waku: Number(wakuText) || 0,
      umaban: Number(umabanText) || 0,
      name: link.text().trim(),
      sexAge,
      weightCarried,
      jockey,
      trainer,
      horseWeight: weightMatch ? Number(weightMatch[1]) : null,
      horseWeightDiff: weightMatch ? Number(weightMatch[2]) : null,
      odds: oddsText && !oddsText.includes('-') ? Number(oddsText) : null,
      popularity: ninkiText && !ninkiText.includes('*') ? Number(ninkiText) : null,
    })
  })

  return { raceId, raceName, course: raceData01, distance, surface, trackCondition, horses }
}

export type PastRace = {
  date: string
  venue: string
  raceName: string
  distance: number
  surface: 'turf' | 'dirt' | 'unknown'
  trackCondition: string
  finishPosition: number | null
  fieldSize: number | null
  popularity: number | null
  jockey: string
  time: string
  agari: string // 上り(上がり3F)
  passingPositions: string // 通過順位 (例: "12-12-11-10")
}

export async function fetchHorseHistory(horseId: string): Promise<PastRace[]> {
  const html = await fetchHtml(`https://db.netkeiba.com/horse/result/${horseId}/`)
  const $ = cheerio.load(html)

  const races: PastRace[] = []
  $('table.db_h_race_results tbody tr, table.db_h_race_results tr').each((_, el) => {
    const cells = $(el).find('td')
    if (cells.length === 0) return

    const get = (i: number) => $(cells[i]).text().trim()
    const date = get(0)
    if (!/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(date)) return // ヘッダ行を除外

    const venue = get(1)
    const raceName = get(4)
    const fieldSizeText = get(6)
    const distText = get(14)
    const distMatch = distText.match(/(\d+)/)
    const surface: PastRace['surface'] = distText.includes('ダ')
      ? 'dirt'
      : distText.includes('芝')
        ? 'turf'
        : 'unknown'
    const trackCondition = get(16)
    const finishText = get(11)
    const popularityText = get(10)
    const jockey = get(12)
    const time = get(18)
    const passingPositions = get(25)
    const agari = get(27)

    races.push({
      date,
      venue,
      raceName,
      distance: distMatch ? Number(distMatch[1]) : 0,
      surface,
      trackCondition,
      finishPosition: /^\d+$/.test(finishText) ? Number(finishText) : null,
      fieldSize: /^\d+$/.test(fieldSizeText) ? Number(fieldSizeText) : null,
      popularity: /^\d+$/.test(popularityText) ? Number(popularityText) : null,
      jockey,
      time,
      agari,
      passingPositions,
    })
  })

  return races
}

// 血統表は3世代(父母・祖父母・曾祖父母)まで保持する
export type Pedigree = {
  sire: string // 父
  dam: string // 母
  sireSire: string // 父父
  sireDam: string // 父母
  damSire: string // 母父(damsire)
  damDam: string // 母母
  sireSireSire: string // 父父父
  sireSireDam: string // 父父母
  sireDamSire: string // 父母父
  sireDamDam: string // 父母母
  damSireSire: string // 母父父
  damSireDam: string // 母父母
  damDamSire: string // 母母父
  damDamDam: string // 母母母
}

// netkeibaの血統表はHTMLの<td rowspan>で世代を表現しているため、
// rowspanを展開して32行×5世代のグリッドに復元してから読み取る
function expandPedigreeGrid($: cheerio.CheerioAPI, table: cheerio.Cheerio<any>): string[][] {
  const COLS = 5
  const rows = table.find('tr')
  const grid: string[][] = []
  const pending: ({ value: string; endRow: number } | null)[] = Array(COLS).fill(null)

  rows.each((r, tr) => {
    grid.push(Array(COLS).fill(''))
    const tds = $(tr).find('td')
    let tdIdx = 0
    for (let c = 0; c < COLS; c++) {
      const carry = pending[c]
      if (carry && carry.endRow > r) {
        grid[r][c] = carry.value
        continue
      }
      const td = tds[tdIdx++]
      if (!td) continue
      const rowspan = parseInt($(td).attr('rowspan') || '1', 10)
      const name = $(td).find('a').first().text().trim().split('\n')[0].trim()
      grid[r][c] = name
      pending[c] = { value: name, endRow: r + rowspan }
    }
  })

  return grid
}

export async function fetchPedigree(horseId: string): Promise<Pedigree> {
  const html = await fetchHtml(`https://db.netkeiba.com/horse/ped/${horseId}/`)
  const $ = cheerio.load(html)
  const table = $('table.blood_table').first()
  const grid = expandPedigreeGrid($, table)
  const at = (r: number, c: number) => grid[r]?.[c] || ''

  return {
    sire: at(0, 0),
    dam: at(16, 0),
    sireSire: at(0, 1),
    sireDam: at(8, 1),
    damSire: at(16, 1),
    damDam: at(24, 1),
    sireSireSire: at(0, 2),
    sireSireDam: at(4, 2),
    sireDamSire: at(8, 2),
    sireDamDam: at(12, 2),
    damSireSire: at(16, 2),
    damSireDam: at(20, 2),
    damDamSire: at(24, 2),
    damDamDam: at(28, 2),
  }
}

export type PayoutCombo = { umaban: number[]; payout: number }

export type RaceResult = {
  raceId: string
  finishOrder: { umaban: number; horseId: string; finishPosition: number }[]
  payouts: {
    tansho: PayoutCombo[]
    fukusho: PayoutCombo[]
    umaren: PayoutCombo[]
    wide: PayoutCombo[]
    umatan: PayoutCombo[] // 着順固定(1着→2着)
    sanrenpuku: PayoutCombo[]
    sanrentan: PayoutCombo[] // 着順固定(1着→2着→3着)
  }
}

// 単勝・複勝など「1つの<td>にdivが並ぶ」形式から、有効な馬番だけを取り出す
function parseFlatUmaban($: cheerio.CheerioAPI, td: cheerio.Cheerio<any>): number[] {
  const vals: number[] = []
  td.find('div > span').each((_, span) => {
    const t = $(span).text().trim()
    if (t) vals.push(Number(t))
  })
  return vals
}

// 馬連・馬単・3連複・3連単など「<ul>ごとに1組」の形式から組み合わせを取り出す
// (ワイドのみ<ul>が複数、他は1つ)
function parseUlCombos($: cheerio.CheerioAPI, td: cheerio.Cheerio<any>): number[][] {
  const combos: number[][] = []
  td.find('ul').each((_, ul) => {
    const nums: number[] = []
    $(ul)
      .find('li span')
      .each((_, span) => {
        const t = $(span).text().trim()
        if (t) nums.push(Number(t))
      })
    if (nums.length > 0) combos.push(nums)
  })
  return combos
}

function parsePayoutValues(td: cheerio.Cheerio<any>): number[] {
  const html = td.find('span').first().html() || ''
  return html
    .split(/<br\s*\/?>/i)
    .map((s) => Number(s.replace(/[^\d]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0)
}

function combosWithPayouts(umabanGroups: number[][], payouts: number[]): PayoutCombo[] {
  return umabanGroups.map((umaban, i) => ({ umaban, payout: payouts[i] ?? 0 }))
}

// レースが確定していればレース結果+払戻を返す。未確定(まだ走っていない)場合はnull。
export async function fetchRaceResult(raceId: string): Promise<RaceResult | null> {
  const html = await fetchHtml('https://race.netkeiba.com/race/result.html', { race_id: raceId })
  const $ = cheerio.load(html)

  const resultTable = $('table.ResultRefund').first()
  if (resultTable.length === 0) return null

  const finishOrder: RaceResult['finishOrder'] = []
  resultTable.find('tbody tr.HorseList').each((_, el) => {
    const row = $(el)
    const posText = row.find('.Result_Num .Rank').text().trim()
    const umabanText = row.find('td.Num:not([class*="Waku"])').first().text().trim()
    const href = row.find('.Horse_Name a').attr('href') || ''
    const idMatch = href.match(/horse\/(\d+)/)
    if (!idMatch || !umabanText) return
    finishOrder.push({
      umaban: Number(umabanText),
      horseId: idMatch[1],
      finishPosition: /^\d+$/.test(posText) ? Number(posText) : 0,
    })
  })
  if (finishOrder.length === 0) return null

  const payoutRow = (cls: string) => $(`tr.${cls}`).first()
  const flatPayout = (cls: string) => {
    const row = payoutRow(cls)
    const umabanGroups = parseFlatUmaban($, row.find('td.Result')).map((u) => [u])
    const payouts = parsePayoutValues(row.find('td.Payout'))
    return combosWithPayouts(umabanGroups, payouts)
  }
  const ulPayout = (cls: string) => {
    const row = payoutRow(cls)
    const umabanGroups = parseUlCombos($, row.find('td.Result'))
    const payouts = parsePayoutValues(row.find('td.Payout'))
    return combosWithPayouts(umabanGroups, payouts)
  }

  return {
    raceId,
    finishOrder,
    payouts: {
      tansho: flatPayout('Tansho'),
      fukusho: flatPayout('Fukusho'),
      umaren: ulPayout('Umaren'),
      wide: ulPayout('Wide'),
      umatan: ulPayout('Umatan'),
      sanrenpuku: ulPayout('Fuku3'),
      sanrentan: ulPayout('Tan3'),
    },
  }
}

function toKaisaiDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

// 今日以降の開催予定レース(まだ結果が出ていないレース)のrace_idを、
// 日付を進めながら開催日が見つかるまで探索して集める
export async function discoverUpcomingRaceIds(
  targetCount: number,
  maxDaysAhead = 21,
  startDate: Date = new Date(),
): Promise<string[]> {
  const raceIds: string[] = []

  for (let dayOffset = 0; dayOffset < maxDaysAhead && raceIds.length < targetCount; dayOffset++) {
    const date = new Date(startDate)
    date.setDate(date.getDate() + dayOffset)
    const kaisaiDate = toKaisaiDate(date)

    let html: string
    try {
      html = await fetchHtml('https://race.netkeiba.com/top/race_list_sub.html', { kaisai_date: kaisaiDate })
    } catch {
      continue
    }

    const matches = [...html.matchAll(/shutuba\.html\?race_id=(\d+)/g)]
    const idsForDay = [...new Set(matches.map((m) => m[1]))]
    for (const id of idsForDay) {
      if (!raceIds.includes(id)) raceIds.push(id)
      if (raceIds.length >= targetCount) break
    }

    if (dayOffset < maxDaysAhead - 1) await jitteredSleep(300, 700)
  }

  return raceIds.slice(0, targetCount)
}

export { sleep, jitteredSleep }
