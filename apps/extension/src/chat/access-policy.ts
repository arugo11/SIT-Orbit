export interface HostAccessRequest {
  origin: string;
  pattern: string;
  sensitive: boolean;
}

const SENSITIVE_PATH = /(?:grade|score|attendance|absence|成績|出席|評価)/iu;
const BLOCKED_SCHEMES = /^(?:javascript|data|file|chrome|chrome-extension):/iu;
const CAMPUS_PRIVATE_REQUEST =
  /(?:scombz|scomb\s*z|sitrus|moodle|my\s*library|cast|履修|成績|出欠|返却期限|貸出履歴|授業資料|講義資料)/iu;
const SCOMBZ_STUDENT_REQUEST =
  /(?:scombz|scomb\s*z|履修|授業(?:情報|内容|ページ|では)|課題|教材|講義資料|授業資料)/iu;
const SITRUS_PERSONAL_REQUEST =
  /(?:sitrus|成績通知|成績一覧|\bgpa\b|私の成績|成績(?:はどう|どうだった|を(?:教えて|見せて|確認))|何単位|取得(?:済み)?単位|取得済み科目|落とした科目|単位(?:は足り|を取|を取得|取れて))/iu;
const PUBLIC_LIBRARY_REQUEST =
  /(?:opac|sit\s*search|図書館|蔵書|所蔵|在架|配架|請求記号|貸出(?:可|状況)|借りられ|借りれる|大学で借り|芝浦で.*借り)/iu;
const ELLIPTICAL_FOLLOWUP =
  /^(?:それ|その|これ|この|さっき|続き|詳しく|他には|じゃあ|では)|(?:確認|検索|探して|読んで|見せて|教えて)/iu;

export function requiresLiveScombzStudentRead(
  message: string,
  options: { processingScope?: string } = {},
): boolean {
  if (PUBLIC_LIBRARY_REQUEST.test(message)) return false;
  if (SCOMBZ_STUDENT_REQUEST.test(message)) return true;
  return (
    (options.processingScope === "personal/scombz_student" ||
      options.processingScope === "mixed") &&
    ELLIPTICAL_FOLLOWUP.test(message)
  );
}

export function requiresSitrusPersonalContext(message: string): boolean {
  return SITRUS_PERSONAL_REQUEST.test(message);
}

export function requiresVerifiedCampusCapability(
  message: string,
  options: {
    onScombzPage?: boolean;
    processingScope?: string;
  } = {},
): boolean {
  return (
    options.processingScope === "personal/scombz_student" ||
    options.processingScope === "restricted/cast_career" ||
    options.processingScope === "mixed" ||
    CAMPUS_PRIVATE_REQUEST.test(message)
  );
}

export function hostAccessRequest(value: string): HostAccessRequest | null {
  try {
    const url = new URL(value);
    if (
      BLOCKED_SCHEMES.test(url.protocol) ||
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return {
      origin: url.origin,
      pattern: `${url.origin}/*`,
      sensitive: SENSITIVE_PATH.test(url.pathname),
    };
  } catch {
    return null;
  }
}
