/** The Cortex mark (a C folded from a ribbon): the light top band over the dark column and bottom band. No imports, so
 *  the sign-in screen can use it as well as the app. `size` in px; decorative (the name sits beside it). */
export default function Logo({ size = 24, className }) {
  return (
    <svg width={size} height={size} viewBox="70 65 640 640" aria-hidden="true" focusable="false" className={className}>
      <path fill="#2337EE" d="M322 75H625A75 75 0 0 1 700 150V190A75 75 0 0 1 625 265H150V335H80V300Q80 290 88 282L268 102Q290 75 322 75Z" />
      <path fill="#0000C8" d="M150 265H268V462A43 43 0 0 0 311 505H572A88 88 0 0 1 660 593V607A88 88 0 0 1 572 695H155A75 75 0 0 1 80 620V335A70 70 0 0 1 150 265Z" />
    </svg>
  );
}
