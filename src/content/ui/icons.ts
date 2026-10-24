/** 内联 SVG 图标 —— 统一 24 视窗，线宽随尺寸分级，无 emoji */

interface IconDef {
  body: string;
  width: number;
}

const defs: Record<string, IconDef> = {
  download: { width: 1.8, body: '<path d="M12 3v10"/><path d="m8 9.5 4 4 4-4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>' },
  video: { width: 1.8, body: '<rect x="3" y="6.5" width="18" height="11" rx="2.5"/><path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" stroke="none"/>' },
  gallery: {
    width: 1.8,
    body: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><circle cx="8.2" cy="9.6" r="1.3" fill="currentColor" stroke="none"/><path d="m3.6 15.6 4.9-4.3 3.4 3 2.6-2.2 6.4 5.4"/>',
  },
  check: { width: 1.8, body: '<path d="m5 12.5 5 5 9-10.5"/>' },
  checkCircle: { width: 1.8, body: '<circle cx="12" cy="12" r="9"/><path d="m8 12.2 3.2 3.2 5.2-5.4"/>' },
  alert: { width: 1.8, body: '<path d="M12 3.8 21.4 20H2.6z"/><path d="M12 9.8v4.4"/><path d="M12 17.3v.2"/>' },
  info: { width: 1.8, body: '<circle cx="12" cy="12" r="9"/><path d="M12 11.2v5.6"/><path d="M12 7.6v.2"/>' },
  close: { width: 1.8, body: '<path d="M6 6l12 12M18 6 6 18"/>' },
  chevronDown: { width: 1.8, body: '<path d="m6 9.5 6 6 6-6"/>' },
  chevronRight: { width: 1.8, body: '<path d="m9.5 6 6 6-6 6"/>' },
  retry: { width: 1.8, body: '<path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.6"/><path d="M19.5 3.6v4.2h-4.2"/>' },
  folder: { width: 1.8, body: '<path d="M3 8a1.5 1.5 0 0 1 1.5-1.5h4.2L11 8.8h8.5A1.5 1.5 0 0 1 21 10.3v7.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>' },
  copy: { width: 1.8, body: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V5.5A1.5 1.5 0 0 0 13.5 4h-9A1.5 1.5 0 0 0 3 5.5v9A1.5 1.5 0 0 0 4.5 16H9"/>' },
  external: { width: 1.8, body: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>' },
  spinner: { width: 1.8, body: '<path d="M12 3a9 9 0 1 0 9 9" stroke-dasharray="42 60"/>' },
  selectAll: { width: 1.8, body: '<rect x="3.5" y="3.5" width="9" height="9" rx="2" stroke-dasharray="3 3"/><path d="m8 15 2.5 2.5L16.5 11"/>' },
  invert: { width: 1.8, body: '<rect x="3.5" y="3.5" width="9" height="9" rx="2"/><rect x="11.5" y="11.5" width="9" height="9" rx="2" fill="currentColor" fill-opacity=".25"/>' },
  gear: {
    width: 1.8,
    body: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v2.6M12 18.8v2.6M21.4 12h-2.6M5.2 12H2.6M18.6 5.4l-1.8 1.8M7.2 16.8l-1.8 1.8M18.6 18.6l-1.8-1.8M7.2 7.2 5.4 5.4"/>',
  },
  shield: { width: 1.8, body: '<path d="M12 3 19 6v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/>' },
  grid: { width: 1.8, body: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>' },
  sort: { width: 1.8, body: '<path d="M4 7h10M4 12h7M4 17h4"/><path d="M17 7v9"/><path d="m14 13 3 3 3-3"/>' },
  pause: { width: 1.8, body: '<path d="M9 5v14M15 5v14"/>' },
  play: { width: 1.8, body: '<path d="M7 4.8 19 12 7 19.2z" fill="currentColor" stroke="none"/>' },
};

export type IconName = keyof typeof defs;

export function icon(name: IconName, size = 18): string {
  const def = defs[name];
  if (!def) return '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${def.width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${def.body}</svg>`;
}

/** 品牌 logo：渐变圆角方块 + 下箭头 */
export function logoSvg(size = 20): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">
    <defs><linearGradient id="rnGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FF5C72"/><stop offset="100%" stop-color="#FF2442"/>
    </linearGradient></defs>
    <path d="M12 3.2v10.4" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
    <path d="m7.8 10.2 4.2 4.2 4.2-4.2" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M4.5 16.4v2.6a1.6 1.6 0 0 0 1.6 1.6h11.8a1.6 1.6 0 0 0 1.6-1.6v-2.6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}
