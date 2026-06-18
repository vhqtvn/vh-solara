// The VHSolara glyph (the "VH" + </ /> marks from the app icon), as a standalone
// recolorable SVG — fill: currentColor, so it takes the theme color anywhere in
// the UI. (The golden tiled icon.svg stays for the favicon / PWA icon.)
// viewBox is the glyph's bounds padded to a square so it centers in square slots.
export default function BrandMark(props: { class?: string }) {
  return (
    <svg class={props.class} viewBox="440 212 136 136" fill="currentColor" role="img" aria-label="VHSolara">
      <path d="M440,236L483,325L498,326L541,237L526,237L493,307L490,309L455,236Z" />
      <path d="M563,236L563,272L561,274L533,274L528,286L562,286L563,326L576,326L576,236Z" />
      <path d="M518,229L513,229L496,266L501,266Z" />
      <path d="M535,300L535,305L547,313L535,321L536,326L554,316L554,311Z" />
      <path d="M490,235L471,246L471,250L490,261L490,255L478,248L490,240Z" />
      <path d="M530,295L524,296L508,331L513,331Z" />
    </svg>
  );
}
