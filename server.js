import express from 'express';
import dotenv from 'dotenv';
import sql from 'mssql';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);

const THERAPISTS_FILE = path.join(__dirname, 'therapists.config.txt');
let therapistConfigCache = null;

async function readTherapistConfig() {
  if (therapistConfigCache) return therapistConfigCache;
  const raw = await fs.readFile(THERAPISTS_FILE, 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !l.startsWith('#'));
  const list = lines.map((line) => {
    const [warriorId, therapistIdStr, displayName, activeStr] = line.split('|').map((x) => (x || '').trim());
    const therapistId = Number(therapistIdStr);
    const active = String(activeStr || '1') !== '0';
    return { warriorId: warriorId.toLowerCase(), therapistId, displayName: displayName || warriorId, active };
  }).filter((x) => x.warriorId && x.therapistId && !Number.isNaN(x.therapistId));
  const byWarriorId = Object.fromEntries(list.map((x) => [x.warriorId, x]));
  therapistConfigCache = { list, byWarriorId };
  return therapistConfigCache;
}

function buildSqlConfig() {
  return {
    server: process.env.LAPIS_SERVER,
    database: process.env.LAPIS_DATABASE,
    user: process.env.LAPIS_USERNAME,
    password: process.env.LAPIS_PASSWORD,
    port: Number(process.env.LAPIS_PORT || 1433),
    options: {
      encrypt: String(process.env.LAPIS_ENCRYPT || 'false') === 'true',
      trustServerCertificate: String(process.env.LAPIS_TRUST_SERVER_CERTIFICATE || 'true') === 'true'
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };
}

let poolPromise = null;
async function getPool() {
  if (!poolPromise) {
    const cfg = buildSqlConfig();
    if (!cfg.server || !cfg.database || !cfg.user || !cfg.password) {
      throw new Error('Missing Lapis connection env vars.');
    }
    poolPromise = sql.connect(cfg);
  }
  return poolPromise;
}

const RANDEVU_SQL = `
  SELECT
    CONVERT(varchar(5), p.BaslangicSaati, 108) AS baslangic,
    CONVERT(varchar(5), p.BitisSaati, 108) AS bitis,
    COALESCE(pe.GorunurAd, per.AdiSoyadi) AS terapist,
    LTRIM(RTRIM(ISNULL(f.MusteriAdi,'') + ' ' + ISNULL(f.MusteriSoyadi,''))) AS musteri,
    ISNULL(ps.OdaNumarasi, f.OdaNumarasi) AS oda_no,
    h.HizmetAdi AS hizmet,
    ps.BirimFiyati AS tutar,
    psd.PlanSatisDurumuAdi AS durum
  FROM t_LP_Planlar p
  LEFT JOIN t_LP_PlanPersonelleri pp ON pp.PlanID = p.PlanID
  LEFT JOIN t_IK_Personeller per ON per.PersonelID = pp.PersonelID
  LEFT JOIN t_LP_PersonellerExt pe ON pe.PersonelIDExt = pp.PersonelID
  LEFT JOIN t_LP_PlanSatislar ps ON ps.PlanID = p.PlanID
  LEFT JOIN t_LP_PlanSatisDurumlari psd ON psd.PlanSatisDurumuID = ps.PlanSatisDurumuID
  LEFT JOIN t_FN_Firmalar f ON f.FirmaID = ps.MusteriID
  LEFT JOIN t_LP_Hizmetler h ON h.HizmetID = p.HizmetID
  WHERE CAST(p.BaslangicSaati AS date) = @targetDate
    AND pp.PersonelID = @therapistId
    AND ps.PlanSatisDurumuID IN (1, 2, 4, 8)
    AND NOT (
      CAST(p.BaslangicSaati AS date) >= '2026-04-10'
      AND (
        COALESCE(pe.GorunurAd, '') COLLATE Latin1_General_CI_AI = 'melike'
        OR COALESCE(per.AdiSoyadi, '') COLLATE Latin1_General_CI_AI LIKE 'melike%'
      )
    )
  ORDER BY p.BaslangicSaati, terapist;
`;

function normalizeTime(value) {
  if (typeof value === 'string') return value.slice(0, 5);
  if (value instanceof Date) {
    const hh = String(value.getHours()).padStart(2, '0');
    const mm = String(value.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  return String(value || '').slice(0, 5);
}

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return -1;
  return h * 60 + m;
}

function dateKeyLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildSlotsFromBooked(bookedSet) {
  const all = [
    '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
    '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
    '17:00', '17:30', '18:00', '18:30', '19:00'
  ];
  return all.map((time) => ({ time, booked: bookedSet.has(time) }));
}

async function getBookedSetForTherapistDate(pool, therapistId, targetDate) {
  const result = await pool.request()
    .input('targetDate', sql.Date, targetDate)
    .input('therapistId', sql.Int, therapistId)
    .query(RANDEVU_SQL);

  const booked = new Set();
  for (const row of result.recordset) {
    const startM = timeToMinutes(row.baslangic);
    const endM = timeToMinutes(row.bitis);
    if (startM < 0) continue;
    const safeEnd = endM > startM ? endM : startM + 30;
    for (let t = startM; t < safeEnd; t += 30) {
      const hh = String(Math.floor(t / 60)).padStart(2, '0');
      const mm = String(t % 60).padStart(2, '0');
      booked.add(`${hh}:${mm}`);
    }
  }
  return booked;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePricingLang(code) {
  const c = String(code || 'en').toLowerCase().slice(0, 2);
  return ['en', 'tr', 'de', 'ru'].includes(c) ? c : 'en';
}

/** Çark dilimi metinleri — dil ile API'den döner */
const WHEEL_SLICE_I18N = {
  en: [
    'Standard session · 5%',
    'Standard session · 10%',
    'Discount · 15%',
    'Discount · 20%',
    'Aromatherapy included · 25%',
    'Aromatherapy package · 30%'
  ],
  tr: [
    'Standart seans · %5',
    'Standart seans · %10',
    'İndirim · %15',
    'İndirim · %20',
    'Aromaterapi dahil · %25',
    'Aromaterapi paketi · %30'
  ],
  de: [
    'Standardsitzung · 5%',
    'Standardsitzung · 10%',
    'Rabatt · 15%',
    'Rabatt · 20%',
    'Aromatherapie inklusive · 25%',
    'Aromatherapie-Paket · 30%'
  ],
  ru: [
    'Стандартный сеанс · 5%',
    'Стандартный сеанс · 10%',
    'Скидка · 15%',
    'Скидка · 20%',
    'С ароматерапией · 25%',
    'Пакет с ароматерапией · 30%'
  ]
};

function normalizeWeights(arr) {
  const sum = arr.reduce((a, b) => a + b, 0);
  if (!sum || !Number.isFinite(sum)) return arr.map(() => 1 / arr.length);
  return arr.map((w) => w / sum);
}

/**
 * Çark dilimleri: hepsi gerçek indirim yüzdesi (Standart / Aromaterapi metin olarak, pct > 0).
 * occupancyRatio 0 → çoğu slot boş → yüksek yüzdeler (%25–30) daha olası;
 * 1 → dolu takvim → düşük yüzdeler (%5–10) daha olası.
 */
function buildDynamicWheelSlices({ occupancyRatio, isWeekend, isPeakHour, dayType, lang }) {
  const t = clamp(occupancyRatio, 0, 1);
  const langKey = normalizePricingLang(lang);
  const labels = WHEEL_SLICE_I18N[langKey] || WHEEL_SLICE_I18N.en;

  const defs = [
    { pct: 5, color: '#2a3a1a', tc: '#6abf6a' },
    { pct: 10, color: '#1e2a10', tc: '#4abf90' },
    { pct: 15, color: '#1a2808', tc: '#c9a84c' },
    { pct: 20, color: '#262008', tc: '#d4b060' },
    { pct: 25, color: '#0a1e2a', tc: '#5db8e0' },
    { pct: 30, color: '#0c1628', tc: '#7ec8ed' }
  ];

  // Boş takvim (t≈0): yüksek dilimlere ağırlık; dolu (t≈1): %5–%10’a ağırlık
  const wEmpty = [0.04, 0.07, 0.14, 0.22, 0.26, 0.27];
  const wFull = [0.34, 0.28, 0.16, 0.12, 0.06, 0.04];

  let weights = defs.map((_, i) => wEmpty[i] * (1 - t) + wFull[i] * t);

  if (isWeekend) {
    weights = weights.map((w, i) => w * (i <= 1 ? 1.08 : i >= 4 ? 0.92 : 1));
  }
  if (isPeakHour) {
    weights = weights.map((w, i) => w * (i <= 2 ? 1.06 : 0.95));
  }
  if (dayType === 'tomorrow') {
    weights = weights.map((w, i) => w * (i >= 3 ? 1.04 : 0.98));
  }

  weights = normalizeWeights(weights);

  return defs.map((item, i) => ({
    label: labels[i] || `${item.pct}%`,
    pct: item.pct,
    type: 'discount',
    color: item.color,
    tc: item.tc,
    weight: Number(weights[i].toFixed(4))
  }));
}

app.get('/api/lapis/slots', async (req, res) => {
  try {
    const cfg = await readTherapistConfig();
    const warriorId = String(req.query.warriorId || '').toLowerCase();
    const therapistIdRaw = req.query.therapistId;
    const therapistId = Number(therapistIdRaw || (cfg.byWarriorId[warriorId] && cfg.byWarriorId[warriorId].therapistId));
    if (!therapistId || Number.isNaN(therapistId)) {
      return res.status(400).json({ error: 'Invalid therapist id.' });
    }

    const pool = await getPool();
    const todayDate = new Date();
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const todayBooked = await getBookedSetForTherapistDate(pool, therapistId, todayDate);
    const tomorrowBooked = await getBookedSetForTherapistDate(pool, therapistId, tomorrowDate);

    return res.json({
      dateToday: dateKeyLocal(todayDate),
      dateTomorrow: dateKeyLocal(tomorrowDate),
      today: buildSlotsFromBooked(todayBooked),
      tomorrow: buildSlotsFromBooked(tomorrowBooked)
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to fetch slots from Lapis.',
      detail: err.message
    });
  }
});

app.get('/api/lapis/pricing', async (req, res) => {
  try {
    const cfg = await readTherapistConfig();
    const warriorId = String(req.query.warriorId || '').toLowerCase();
    const therapistIdRaw = req.query.therapistId;
    const therapistId = Number(therapistIdRaw || (cfg.byWarriorId[warriorId] && cfg.byWarriorId[warriorId].therapistId));
    const dayType = String(req.query.day || 'today').toLowerCase() === 'tomorrow' ? 'tomorrow' : 'today';
    const selectedTime = String(req.query.time || '');
    const lang = normalizePricingLang(req.query.lang);

    if (!therapistId || Number.isNaN(therapistId)) {
      return res.status(400).json({ error: 'Invalid therapist id.' });
    }

    const pool = await getPool();
    const targetDate = new Date();
    if (dayType === 'tomorrow') targetDate.setDate(targetDate.getDate() + 1);
    const booked = await getBookedSetForTherapistDate(pool, therapistId, targetDate);

    const totalSlots = 21;
    const occupancyRatio = clamp(booked.size / totalSlots, 0, 1);

    const baseDate = new Date();
    if (dayType === 'tomorrow') baseDate.setDate(baseDate.getDate() + 1);
    const isWeekend = [0, 6].includes(baseDate.getDay());
    const hour = Number((selectedTime || '00:00').split(':')[0]);
    const isPeakHour = hour >= 17 && hour <= 19;

    const slices = buildDynamicWheelSlices({ occupancyRatio, isWeekend, isPeakHour, dayType, lang });

    return res.json({
      meta: {
        occupancyRatio,
        bookedCount: booked.size,
        totalSlots,
        isWeekend,
        isPeakHour,
        dayType,
        lang
      },
      slices
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to calculate dynamic pricing wheel.',
      detail: err.message
    });
  }
});

app.get('/api/config/therapists', async (_req, res) => {
  try {
    const cfg = await readTherapistConfig();
    return res.json({
      therapists: cfg.list
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to read therapist config.',
      detail: err.message
    });
  }
});

app.use(express.static(__dirname));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'spa-warriors.html'));
});

app.listen(port, () => {
  console.log(`Sense Spa Quest running on http://localhost:${port}`);
});
