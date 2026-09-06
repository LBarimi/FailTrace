// Presentation only: macOS-style window chrome, not a captured operating system.
export const width = 1040;
export const height = 660;
export const colors = { ink: '#edf1f7', muted: '#a4afc0', green: '#8cdec0', red: '#ff939f', amber: '#f3cf8c', blue: '#9cbeff' };
export const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const text = (x, y, value, color = colors.ink, size = 21, extra = '') =>
  `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" xml:space="preserve" ${extra}>${escape(value)}</text>`;
export const mono = `font-family="'SF Mono', Menlo, 'DejaVu Sans Mono', Consolas, monospace"`;

// The pointer annotates an observed result; it does not imply a clickable control.
export function windowFrame({ title, body, cursor }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(title)}">
<defs>
  <linearGradient id="desktop" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#354765"/><stop offset=".52" stop-color="#262c45"/><stop offset="1" stop-color="#183e45"/></linearGradient>
  <linearGradient id="titlebar" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#353943"/><stop offset="1" stop-color="#292e38"/></linearGradient>
  <filter id="shadow" x="-.2" y="-.2" width="1.4" height="1.5"><feDropShadow dy="8" stdDeviation="10" flood-opacity=".3"/></filter>
  <filter id="pointer-shadow" x="-.6" y="-.4" width="2.5" height="2"><feDropShadow dx="1" dy="2" stdDeviation="1.5" flood-opacity=".65"/></filter>
</defs>
<rect width="1040" height="660" rx="18" fill="url(#desktop)"/>
<rect x="24" y="24" width="992" height="596" rx="12" fill="#09111d" stroke="#687081" stroke-opacity=".5" filter="url(#shadow)"/>
<path d="M36 24H1004Q1016 24 1016 36V68H24V36Q24 24 36 24" fill="url(#titlebar)"/>
<circle cx="47" cy="46" r="6.5" fill="#ff6059"/><circle cx="69" cy="46" r="6.5" fill="#ffbd2e"/><circle cx="91" cy="46" r="6.5" fill="#28c840"/>
<g font-family="Arial, 'DejaVu Sans', sans-serif">
${text(520, 52, title, '#d6dce7', 15, 'text-anchor="middle"')}
<g transform="translate(40 84)">${body}</g>
</g>
<g transform="translate(${cursor[0]} ${cursor[1]}) scale(1.3)" filter="url(#pointer-shadow)">
<path d="M0 0V29L7.8 21.5L14 35L19.5 32.5L13.2 19H24Z" fill="#12151b" stroke="white" stroke-width="1.8" stroke-linejoin="round"/>
</g></svg>\n`;
}
