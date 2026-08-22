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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

  return { raceId, raceName, course: raceData01, distance, surface, horses }
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
    })
  })

  return races
}

export type Pedigree = {
  sire: string // 父
  sireSire: string // 父父
  sireDam: string // 父母
  dam: string // 母
  damSire: string // 母父(damsire)
  damDam: string // 母母
}

export async function fetchPedigree(horseId: string): Promise<Pedigree> {
  const res = await axios.get('https://db.netkeiba.com/horse/ajax_horse_pedigree.html', {
    params: { input: 'UTF-8', output: 'json', id: horseId },
    headers: { 'User-Agent': UA },
    timeout: 15000,
  })
  const html: string = res.data?.data || ''
  const $ = cheerio.load(html)
  const names = $('table.blood_table td')
    .map((_, td) => $(td).text().trim())
    .get()

  return {
    sire: names[0] || '',
    sireSire: names[1] || '',
    sireDam: names[2] || '',
    dam: names[3] || '',
    damSire: names[4] || '',
    damDam: names[5] || '',
  }
}

export { sleep }
