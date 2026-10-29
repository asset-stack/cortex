import { LEADS } from '@/data/boards';

// The two Lead marks (§21), traced from the owner's icons: AssetStack's folded square on blue, LYCO's L with its green
// corner. No imports beyond the labels, so any screen can use them.
const MARKS = {
  assetstack: (
    <>
      <rect x="0" y="11" width="844" height="844" rx="120" fill="#1d31eb" />
      <path fill="#fff" fillRule="evenodd"
        d="M345 125H655Q725 125 725 195V495Q725 525 705 545L545 705Q505 745 470 745H175Q105 745 105 675V385Q105 345 135 315L295 155Q325 125 345 125ZM295 315H485Q535 315 535 365V555H345Q295 555 295 505Z" />
    </>
  ),
  lyco: (
    <>
      <rect width="200" height="200" rx="28" fill="#1e3b3b" />
      <path fill="#22e36b" d="M22 22H62L22 62Z" />
      <path fill="#fff" d="M71 62H92V121H133V140H71Z" />
    </>
  ),
};
const VIEW = { assetstack: '0 11 844 844', lyco: '0 0 200 200' };

/** A deal's or client's Lead as its small mark (nothing when it has none). It names itself ("LYCO lead · co-pitched")
 *  unless `decorative`, for when the words are already beside it. */
export default function LeadIcon({ lead, size = 16, className, decorative = false }) {
  if (typeof lead !== 'string' || !Object.hasOwn(MARKS, lead)) return null;
  const label = LEADS[lead].title;
  return (
    <svg width={size} height={size} viewBox={VIEW[lead]} className={className} focusable="false"
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}>
      {!decorative && <title>{label}</title>}
      {MARKS[lead]}
    </svg>
  );
}
