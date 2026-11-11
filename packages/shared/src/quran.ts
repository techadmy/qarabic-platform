import { z } from 'zod';

/**
 * The Quran reference (Hafs numbering): 114 surahs with their Arabic and English names, ayah count
 * and the juz where each starts. Copied from the Laravel `database/data/quran_surahs.php`; the API
 * migration seeds the `quran_surahs` table from the same rows (a test checks they match). Total
 * ayahs: 6,236.
 */
export const surahSchema = z.object({
  number: z.number().int(),
  nameAr: z.string(),
  nameEn: z.string(),
  ayahCount: z.number().int(),
  juzStart: z.number().int(),
});
export type SurahDto = z.infer<typeof surahSchema>;

/** `GET /quran/surahs` (any signed-in user; cacheable for a day). */
export const surahListSchema = z.array(surahSchema);

// prettier-ignore
const ROWS: ReadonlyArray<readonly [number, string, string, number, number]> = [
  [1, 'الفاتحة', 'Al-Fatihah', 7, 1],
  [2, 'البقرة', 'Al-Baqarah', 286, 1],
  [3, 'آل عمران', 'Al-Imran', 200, 3],
  [4, 'النساء', 'An-Nisa', 176, 4],
  [5, 'المائدة', 'Al-Ma\'idah', 120, 6],
  [6, 'الأنعام', 'Al-An\'am', 165, 7],
  [7, 'الأعراف', 'Al-A\'raf', 206, 8],
  [8, 'الأنفال', 'Al-Anfal', 75, 9],
  [9, 'التوبة', 'At-Tawbah', 129, 10],
  [10, 'يونس', 'Yunus', 109, 11],
  [11, 'هود', 'Hud', 123, 11],
  [12, 'يوسف', 'Yusuf', 111, 12],
  [13, 'الرعد', 'Ar-Ra\'d', 43, 13],
  [14, 'إبراهيم', 'Ibrahim', 52, 13],
  [15, 'الحجر', 'Al-Hijr', 99, 14],
  [16, 'النحل', 'An-Nahl', 128, 14],
  [17, 'الإسراء', 'Al-Isra', 111, 15],
  [18, 'الكهف', 'Al-Kahf', 110, 15],
  [19, 'مريم', 'Maryam', 98, 16],
  [20, 'طه', 'Ta-Ha', 135, 16],
  [21, 'الأنبياء', 'Al-Anbiya', 112, 17],
  [22, 'الحج', 'Al-Hajj', 78, 17],
  [23, 'المؤمنون', 'Al-Mu\'minun', 118, 18],
  [24, 'النور', 'An-Nur', 64, 18],
  [25, 'الفرقان', 'Al-Furqan', 77, 18],
  [26, 'الشعراء', 'Ash-Shu\'ara', 227, 19],
  [27, 'النمل', 'An-Naml', 93, 19],
  [28, 'القصص', 'Al-Qasas', 88, 20],
  [29, 'العنكبوت', 'Al-Ankabut', 69, 20],
  [30, 'الروم', 'Ar-Rum', 60, 21],
  [31, 'لقمان', 'Luqman', 34, 21],
  [32, 'السجدة', 'As-Sajdah', 30, 21],
  [33, 'الأحزاب', 'Al-Ahzab', 73, 21],
  [34, 'سبأ', 'Saba', 54, 22],
  [35, 'فاطر', 'Fatir', 45, 22],
  [36, 'يس', 'Ya-Sin', 83, 22],
  [37, 'الصافات', 'As-Saffat', 182, 23],
  [38, 'ص', 'Sad', 88, 23],
  [39, 'الزمر', 'Az-Zumar', 75, 23],
  [40, 'غافر', 'Ghafir', 85, 24],
  [41, 'فصلت', 'Fussilat', 54, 24],
  [42, 'الشورى', 'Ash-Shura', 53, 25],
  [43, 'الزخرف', 'Az-Zukhruf', 89, 25],
  [44, 'الدخان', 'Ad-Dukhan', 59, 25],
  [45, 'الجاثية', 'Al-Jathiyah', 37, 25],
  [46, 'الأحقاف', 'Al-Ahqaf', 35, 26],
  [47, 'محمد', 'Muhammad', 38, 26],
  [48, 'الفتح', 'Al-Fath', 29, 26],
  [49, 'الحجرات', 'Al-Hujurat', 18, 26],
  [50, 'ق', 'Qaf', 45, 26],
  [51, 'الذاريات', 'Adh-Dhariyat', 60, 26],
  [52, 'الطور', 'At-Tur', 49, 27],
  [53, 'النجم', 'An-Najm', 62, 27],
  [54, 'القمر', 'Al-Qamar', 55, 27],
  [55, 'الرحمن', 'Ar-Rahman', 78, 27],
  [56, 'الواقعة', 'Al-Waqi\'ah', 96, 27],
  [57, 'الحديد', 'Al-Hadid', 29, 27],
  [58, 'المجادلة', 'Al-Mujadilah', 22, 28],
  [59, 'الحشر', 'Al-Hashr', 24, 28],
  [60, 'الممتحنة', 'Al-Mumtahanah', 13, 28],
  [61, 'الصف', 'As-Saff', 14, 28],
  [62, 'الجمعة', 'Al-Jumu\'ah', 11, 28],
  [63, 'المنافقون', 'Al-Munafiqun', 11, 28],
  [64, 'التغابن', 'At-Taghabun', 18, 28],
  [65, 'الطلاق', 'At-Talaq', 12, 28],
  [66, 'التحريم', 'At-Tahrim', 12, 28],
  [67, 'الملك', 'Al-Mulk', 30, 29],
  [68, 'القلم', 'Al-Qalam', 52, 29],
  [69, 'الحاقة', 'Al-Haqqah', 52, 29],
  [70, 'المعارج', 'Al-Ma\'arij', 44, 29],
  [71, 'نوح', 'Nuh', 28, 29],
  [72, 'الجن', 'Al-Jinn', 28, 29],
  [73, 'المزمل', 'Al-Muzzammil', 20, 29],
  [74, 'المدثر', 'Al-Muddaththir', 56, 29],
  [75, 'القيامة', 'Al-Qiyamah', 40, 29],
  [76, 'الإنسان', 'Al-Insan', 31, 29],
  [77, 'المرسلات', 'Al-Mursalat', 50, 29],
  [78, 'النبأ', 'An-Naba', 40, 30],
  [79, 'النازعات', 'An-Nazi\'at', 46, 30],
  [80, 'عبس', 'Abasa', 42, 30],
  [81, 'التكوير', 'At-Takwir', 29, 30],
  [82, 'الانفطار', 'Al-Infitar', 19, 30],
  [83, 'المطففين', 'Al-Mutaffifin', 36, 30],
  [84, 'الانشقاق', 'Al-Inshiqaq', 25, 30],
  [85, 'البروج', 'Al-Buruj', 22, 30],
  [86, 'الطارق', 'At-Tariq', 17, 30],
  [87, 'الأعلى', 'Al-A\'la', 19, 30],
  [88, 'الغاشية', 'Al-Ghashiyah', 26, 30],
  [89, 'الفجر', 'Al-Fajr', 30, 30],
  [90, 'البلد', 'Al-Balad', 20, 30],
  [91, 'الشمس', 'Ash-Shams', 15, 30],
  [92, 'الليل', 'Al-Layl', 21, 30],
  [93, 'الضحى', 'Ad-Duha', 11, 30],
  [94, 'الشرح', 'Ash-Sharh', 8, 30],
  [95, 'التين', 'At-Tin', 8, 30],
  [96, 'العلق', 'Al-Alaq', 19, 30],
  [97, 'القدر', 'Al-Qadr', 5, 30],
  [98, 'البينة', 'Al-Bayyinah', 8, 30],
  [99, 'الزلزلة', 'Az-Zalzalah', 8, 30],
  [100, 'العاديات', 'Al-Adiyat', 11, 30],
  [101, 'القارعة', 'Al-Qari\'ah', 11, 30],
  [102, 'التكاثر', 'At-Takathur', 8, 30],
  [103, 'العصر', 'Al-Asr', 3, 30],
  [104, 'الهمزة', 'Al-Humazah', 9, 30],
  [105, 'الفيل', 'Al-Fil', 5, 30],
  [106, 'قريش', 'Quraysh', 4, 30],
  [107, 'الماعون', 'Al-Ma\'un', 7, 30],
  [108, 'الكوثر', 'Al-Kawthar', 3, 30],
  [109, 'الكافرون', 'Al-Kafirun', 6, 30],
  [110, 'النصر', 'An-Nasr', 3, 30],
  [111, 'المسد', 'Al-Masad', 5, 30],
  [112, 'الإخلاص', 'Al-Ikhlas', 4, 30],
  [113, 'الفلق', 'Al-Falaq', 5, 30],
  [114, 'الناس', 'An-Nas', 6, 30],
];

export const QURAN_SURAHS: readonly SurahDto[] = ROWS.map(
  ([number, nameAr, nameEn, ayahCount, juzStart]) => ({
    number,
    nameAr,
    nameEn,
    ayahCount,
    juzStart,
  }),
);

export const SURAH_COUNT = 114;
export const QURAN_AYAH_COUNT = 6236;

/** Ayahs in a surah (0 for a number outside 1–114). */
export function ayahCountOf(surah: number): number {
  return QURAN_SURAHS[surah - 1]?.ayahCount ?? 0;
}

interface Point {
  surah: number;
  ayah: number;
}

/**
 * Ayahs covered by a range: inside one surah `to − from + 1`; across surahs the sum of the parts,
 * in either direction (Juz Amma is often memorised backwards, An-Nas → An-Naba). Port of Laravel
 * `ProgressController::ayahs`.
 */
export function ayahsInRange(from: Point, to: Point): number {
  if (from.surah === to.surah) return Math.max(0, to.ayah - from.ayah + 1);
  const step = from.surah < to.surah ? 1 : -1;
  let total = ayahCountOf(from.surah) - from.ayah + 1 + to.ayah;
  for (let s = from.surah + step; s !== to.surah; s += step) total += ayahCountOf(s);
  return total;
}

/**
 * Every (surah, first..last ayah) piece a range covers, in reading order of the range: the pieces
 * a coverage map adds up.
 */
export function rangePieces(
  from: Point,
  to: Point,
): Array<{ surah: number; first: number; last: number }> {
  if (from.surah === to.surah) {
    return [
      {
        surah: from.surah,
        first: Math.min(from.ayah, to.ayah),
        last: Math.max(from.ayah, to.ayah),
      },
    ];
  }
  const step = from.surah < to.surah ? 1 : -1;
  const pieces = [{ surah: from.surah, first: from.ayah, last: ayahCountOf(from.surah) }];
  for (let s = from.surah + step; s !== to.surah; s += step) {
    pieces.push({ surah: s, first: 1, last: ayahCountOf(s) });
  }
  pieces.push({ surah: to.surah, first: 1, last: to.ayah });
  return pieces;
}
