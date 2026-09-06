/** Looking for complaints in languages other than English.
 *
 *  These products are global and the search was not. Every query the discovery
 *  stage issues is English — "X doesn't work", "X broken", "X review" — so a
 *  developer tools company with a large Chinese or Japanese user base looked,
 *  from the dashboard, like it had none. That is not a smaller corpus; it is a
 *  different corpus, and it is invisible rather than sparse.
 *
 *  Two things are needed for a language and this module holds both:
 *
 *  - **Queries.** The product name usually stays in Latin script — people write
 *    "Bolt.new 崩溃", not a transliteration — so a query is the brand plus a
 *    complaint word, plus the venues where that language's developers actually
 *    argue. Zhihu and V2EX are not reachable from an English `site:` sweep at
 *    any page depth.
 *  - **Recognition.** The complaint vocabulary in search.ts is `\b`-anchored
 *    English. Chinese and Japanese have no word boundaries at all, so every
 *    pattern in it fails on CJK text — a thread saying 一直崩溃 would be fetched
 *    and then filed as ordinary neutral chatter. The patterns here are matched
 *    as plain substrings for exactly that reason.
 *
 *  Not translated by a model. These are twenty fixed words per language; asking
 *  a model to produce them on every run would be slower, non-deterministic, and
 *  no better — and the house style is that the model judges text that
 *  deterministic code has already fetched.
 */

export interface LanguagePack {
  code: string;
  label: string;
  /** Complaint words, used both to build queries and to recognise results. */
  complaint: string[];
  /** Where this language's developers and users actually post. */
  venues: string[];
  /** you.com and Brave both take a language hint; passing it stops a query in
   *  Japanese being answered with English pages about the same product. */
  hint: string;
}

export const LANGUAGES: LanguagePack[] = [
  {
    code: 'zh',
    label: 'Chinese',
    // 崩溃 crash · 报错 throws an error · 卡死 frozen · 用不了 unusable ·
    // 打不开 won't open · 失败 failed · 问题 problem · 坑 a trap, the usual
    // word for "this thing burned me" · 难用 hard to use · 退款 refund
    complaint: ['崩溃', '报错', '卡死', '用不了', '打不开', '失败', '问题', '坑', '难用', '退款'],
    venues: ['zhihu.com', 'v2ex.com', 'juejin.cn', 'csdn.net', 'segmentfault.com', 'bilibili.com'],
    hint: 'zh',
  },
  {
    code: 'ja',
    label: 'Japanese',
    // 動かない doesn't work · エラー error · 落ちる crashes · バグ bug ·
    // 使えない unusable · 不具合 defect · できない can't · 重い sluggish
    complaint: ['動かない', 'エラー', '落ちる', 'バグ', '使えない', '不具合', 'できない', '重い'],
    venues: ['qiita.com', 'zenn.dev', 'note.com', 'hatenablog.com', 'teratail.com'],
    hint: 'ja',
  },
  {
    code: 'ko',
    label: 'Korean',
    // 오류 error · 안됨 doesn't work · 버그 bug · 먹통 dead/unresponsive ·
    // 느림 slow · 실패 failure · 문제 problem · 환불 refund
    complaint: ['오류', '안됨', '버그', '먹통', '느림', '실패', '문제', '환불'],
    venues: ['velog.io', 'tistory.com', 'okky.kr', 'clien.net', 'inven.co.kr'],
    hint: 'ko',
  },
  {
    code: 'es',
    label: 'Spanish',
    complaint: ['no funciona', 'error', 'falla', 'problema', 'se cierra', 'lento'],
    venues: ['es.stackoverflow.com', 'medium.com', 'dev.to'],
    hint: 'es',
  },
  {
    code: 'pt',
    label: 'Portuguese',
    complaint: ['não funciona', 'erro', 'falha', 'problema', 'travando', 'lento'],
    venues: ['pt.stackoverflow.com', 'tabnews.com.br', 'dev.to'],
    hint: 'pt',
  },
  {
    code: 'de',
    label: 'German',
    complaint: ['funktioniert nicht', 'fehler', 'absturz', 'problem', 'langsam'],
    venues: ['heise.de', 'golem.de', 'dev.to'],
    hint: 'de',
  },
  {
    code: 'fr',
    label: 'French',
    complaint: ['ne fonctionne pas', 'erreur', 'plantage', 'problème', 'lent'],
    venues: ['developpez.net', 'linuxfr.org', 'dev.to'],
    hint: 'fr',
  },
  {
    code: 'ru',
    label: 'Russian',
    complaint: ['не работает', 'ошибка', 'вылетает', 'проблема', 'тормозит'],
    venues: ['habr.com', 'vc.ru', 'pikabu.ru'],
    hint: 'ru',
  },
];

/** Which languages a scan searches in. Everything, unless told otherwise.
 *
 *  This was a set of opt-in toggles and that was the wrong shape. A language
 *  barrier is a human constraint: a person watches a product in the languages
 *  they read, so choosing is natural for them and meaningless here. The
 *  pipeline has no preference and the model reads Japanese as readily as
 *  English, so the only thing a toggle achieved was making the default answer
 *  wrong for every global product.
 *
 *  Cost is handled by spending less per language rather than by asking first —
 *  see `queriesFor`. An explicit list still narrows it, for the case where
 *  somebody knows the audience is one market. */
export const enabledLanguages = (codes: string[] | undefined): LanguagePack[] =>
  (codes === undefined || codes.length === 0)
    ? LANGUAGES
    : codes.map((code) => LANGUAGES.find((l) => l.code === code)).filter((l): l is LanguagePack => Boolean(l));

/** The queries for one language.
 *
 *  Two shapes, and both are needed. The complaint words find the discussion
 *  wherever it happens; the venue queries find the places an English sweep
 *  cannot reach even in principle, where the discussion may never use a word
 *  from the first list.
 *
 *  `deep` decides how much is spent per language. Every language runs on every
 *  scan, so the normal run takes two of each — enough to know whether there is
 *  anything there at all — and a deep run takes the lot. That is the right
 *  place for the cost trade: how much per language, never which languages. */
export function queriesFor(pack: LanguagePack, brand: string, deep: boolean): string[] {
  const words = deep ? pack.complaint : pack.complaint.slice(0, 2);
  const venues = deep ? pack.venues : pack.venues.slice(0, 2);
  // De-duplicated, because several packs share a venue — dev.to is where
  // Spanish, Portuguese, German and French developers all post — and issuing
  // the identical query four times is four cache lookups pretending to be
  // coverage.
  return [...new Set([
    ...words.map((word) => `"${brand}" ${word}`),
    ...venues.map((venue) => `site:${venue} ${brand}`),
  ])];
}

/** Does this text read as a complaint in one of these languages?
 *
 *  Two matching rules, because the scripts need different ones.
 *
 *  CJK is matched as a plain substring. `\b` is a transition between word and
 *  non-word characters, and Chinese and Japanese have none — so `\b崩溃\b`
 *  never matches anything, which is how the English vocabulary silently
 *  classified every Chinese complaint as neutral chatter.
 *
 *  Latin script is matched on word boundaries, and must be: the words are short
 *  and generic, so a bare substring test has `lento` firing on "talento",
 *  `falla` on "fallacy" and `error` on half the internet. Getting this wrong
 *  does not fail loudly — it quietly marks ordinary posts as complaints, which
 *  is the corpus lying about itself. */
const LATIN = /^[\p{Script=Latin}\s'-]+$/u;

const matchers = new WeakMap<LanguagePack, RegExp>();

function matcherFor(pack: LanguagePack): RegExp {
  const cached = matchers.get(pack);
  if (cached) return cached;
  const built = new RegExp(
    pack.complaint
      .map((word) => {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return LATIN.test(word) ? String.raw`(^|[^\p{L}])${escaped}([^\p{L}]|$)` : escaped;
      })
      .join('|'),
    'iu',
  );
  matchers.set(pack, built);
  return built;
}

export function complaintInAnyLanguage(text: string, packs: LanguagePack[]): boolean {
  return packs.some((pack) => matcherFor(pack).test(text));
}

/** Every complaint word across every pack, for the case where a mention's
 *  language is not known in advance — which is all of them, because a result
 *  is judged before anyone has asked what language it is in. Cheap: a few dozen
 *  substring tests over a title and a snippet. */
export const anyComplaintWord = (text: string): boolean =>
  complaintInAnyLanguage(text, LANGUAGES);
