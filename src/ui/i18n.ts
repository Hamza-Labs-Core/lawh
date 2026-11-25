export type Lang = 'en' | 'ar';

// Arabic doesn't assume the reader's gender: nouns and passives, no commands.
const TEXT = {
  app: ['Lawh', 'لوح'],
  tagline: ['A private reading room for pages that agents publish.', 'غرفة قراءة خاصة للصفحات التي ينشرها الوكلاء.'],
  light: ['Light', 'فاتح'],
  dark: ['Dark', 'داكن'],
  otherLang: ['العربية', 'English'],
  signIn: ['Sign in with a passkey', 'الدخول بمفتاح مرور'],
  fromOther: ['Approve from another device', 'الموافقة من جهاز آخر'],
  signOut: ['Sign out', 'تسجيل الخروج'],
  noPasskeys: ['This browser can’t use passkeys. Approve from another device instead.', 'لا يدعم هذا المتصفح مفاتيح المرور. الموافقة ممكنة من جهاز آخر.'],
  failed: ['That did not work. Try again.', 'لم ينجح ذلك. المحاولة مرة أخرى ممكنة.'],
  wait: ['Too many tries. Wait a minute.', 'محاولات كثيرة. يلزم الانتظار دقيقة.'],
  offline: ['No connection.', 'لا يوجد اتصال.'],
  retry: ['Try again', 'إعادة المحاولة'],
  back: ['Back', 'رجوع'],
  loading: ['Loading…', 'جارٍ التحميل…'],
  welcome: ['Welcome, {name}', 'أهلًا {name}'],
  ownerLink: ['Create a passkey to manage this copy of Lawh.', 'إنشاء مفتاح مرور لإدارة هذه النسخة من لوح.'],
  resetLink: ['Create a new passkey. Your other passkeys stop working and your sessions end.', 'إنشاء مفتاح مرور جديد. تتوقف مفاتيحك الأخرى وتنتهي جلساتك.'],
  inviteLink: ['{inviter} invited you to {team} as: {level}.', 'دعوة من {inviter} إلى {team}، بمستوى: {level}.'],
  level1: ['Viewer', 'مشاهدة'],
  level2: ['Commenter', 'تعليق'],
  level3: ['Decider', 'اتخاذ القرار'],
  level4: ['Manager', 'إدارة'],
  create: ['Create a passkey', 'إنشاء مفتاح مرور'],
  join: ['Join with a passkey', 'انضمام بمفتاح مرور'],
  passkeyHelp: ['Your phone or computer asks for your face, fingerprint or screen lock. There is no password.', 'سيطلب هاتفك أو حاسوبك بصمة الوجه أو الإصبع أو قفل الشاشة. لا توجد كلمة مرور.'],
  badLink: ['This link doesn’t work. It may have been used, or be too old.', 'هذا الرابط لا يعمل. ربما استُخدم أو انتهت مدته.'],
  signedIn: ['Signed in as {name}', 'تم الدخول باسم {name}'],
  isOff: ['This copy is off. Nobody else can reach it.', 'هذه النسخة متوقفة، ولا يصل إليها أحد سواك.'],
  isOn: ['This copy is on.', 'هذه النسخة تعمل.'],
  turnOn: ['Turn on', 'تشغيل'],
  account: ['Account', 'الحساب'],
  pages: ['Pages', 'الصفحات'],
  allProjects: ['All projects', 'كل المشاريع'],
  anyStatus: ['Any status', 'كل الحالات'],
  draft: ['Draft', 'مسودة'],
  in_review: ['In review', 'قيد المراجعة'],
  decided: ['Decided', 'حُسم'],
  archived: ['Archived', 'مؤرشف'],
  project: ['Project', 'المشروع'],
  status: ['Status', 'الحالة'],
  tag: ['Tag', 'الوسم'],
  tagHint: ['Type a tag', 'كتابة وسم'],
  clearTag: ['Remove the tag filter', 'إزالة تصفية الوسم'],
  noTags: ['No tags', 'لا توجد وسوم'],
  version: ['Version {n}', 'الإصدار {n}'],
  versions: ['Versions', 'الإصدارات'],
  more: ['Show more', 'عرض المزيد'],
  noPages: ['No pages here yet.', 'لا توجد صفحات هنا بعد.'],
  noMatches: ['No pages match these filters.', 'لا توجد صفحات تطابق هذه التصفية.'],
  clear: ['Clear filters', 'مسح التصفية'],
  noProjects: ['You’re in no project yet.', 'لم تتم إضافتك إلى أي مشروع بعد.'],
  pageGone: ['This page isn’t here, or you can’t see it.', 'هذه الصفحة غير موجودة، أو لا تتوفر لك.'],
  oldVersion: ['You’re reading version {n}. The current one is {current}.', 'المعروض هو الإصدار {n}. الإصدار الحالي هو {current}.'],
  toCurrent: ['Go to the current version', 'الانتقال إلى الإصدار الحالي'],
  current: ['Current', 'الحالي'],
  by: ['by {agent}, {date}', 'من {agent}، {date}'],
  updated: ['Updated {date}', 'آخر تحديث {date}'],
  pageFrame: ['Page: {title}', 'صفحة: {title}'],
  slow: ['The page is taking long to load.', 'يستغرق تحميل الصفحة وقتًا طويلًا.'],
  reload: ['Load again', 'إعادة التحميل'],
  leaveTitle: ['Open another site?', 'فتح موقع آخر؟'],
  leaveHelp: ['The page wants to open this address. It is not part of Lawh.', 'تريد الصفحة فتح هذا العنوان. وهو ليس من لوح.'],
  open: ['Open', 'فتح'],
  cancel: ['Cancel', 'إلغاء'],
  close: ['Close', 'إغلاق'],
  codeHere: ['On a device that is signed in, open {url} and type this code.', 'على جهاز سبق الدخول منه، يُفتح {url} ويُكتب هذا الرمز.'],
  codeEnds: ['It works for 5 minutes.', 'يعمل لمدة {five} دقائق.'],
  codeOver: ['The code is too old.', 'انتهت مدة الرمز.'],
  newCode: ['New code', 'رمز جديد'],
  approveTitle: ['Sign in another device', 'إدخال جهاز آخر'],
  approveHelp: ['Type the code the other device shows.', 'يلزم إدخال الرمز الذي يعرضه الجهاز الآخر.'],
  approveWarn: ['Continue only if you started this. If someone sent you a code, don’t type it.', 'المتابعة فقط إن كان هذا الطلب منك. أي رمز يصلك من شخص آخر يجب ألا يُكتب هنا.'],
  next: ['Continue', 'متابعة'],
  approveAsk: ['Sign in {label} as you?', 'إدخال {label} باسمك؟'],
  approve: ['Approve', 'موافقة'],
  approved: ['Approved. The other device is signing in.', 'تمت الموافقة. يجري دخول الجهاز الآخر.'],
  badCode: ['That code doesn’t work.', 'هذا الرمز لا يعمل.'],
  noPasskeysHere: ['This browser can’t use passkeys. Open the link in another browser or on another device.', 'لا يدعم هذا المتصفح مفاتيح المرور. يمكن فتح الرابط في متصفح أو جهاز آخر.'],
} as const;

export type Key = keyof typeof TEXT;

/** A day, in the language's own calendar words and digits. */
export const day = (lang: Lang, at: number): string => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-u-ca-gregory-nu-arab' : 'en-US', { dateStyle: 'medium' }).format(at);

/** The text cut at its places: plain parts, and `{ value }` for what fills one. */
export function parts(lang: Lang, key: Key, values: Record<string, string> = {}): (string | { value: string })[] {
  return TEXT[key][lang === 'ar' ? 1 : 0].split(/(\{\w+\})/).filter((part) => part !== '').map((part) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name === undefined ? part : name === 'five' ? digits(lang, 5) : { value: values[name] ?? '' };
  });
}

/** As one string, for a title or an attribute. On a screen, places are filled by `Fill`, which isolates them. */
export const translate = (lang: Lang, key: Key, values?: Record<string, string>): string => parts(lang, key, values).map((part) => (typeof part === 'string' ? part : part.value)).join('');

/** Numbers as the language writes them: ٠–٩ in Arabic. */
export const digits = (lang: Lang, value: number | string): string => (lang === 'ar' ? String(value).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]!) : String(value));

/** Every text has both languages, and the same places to fill. Checked by a test. */
export const allTexts = TEXT as Record<string, readonly [string, string]>;
