/**
 * 核心逻辑单元测试。
 *
 * 重点覆盖「靠线上实测才确定」的规则 —— 这些是最容易回归、也最难排查的地方：
 *   - 小红书图片 CDN 的原图直链推导
 *   - 视频流分桶名随版本变化（EF4/EF5 与 h264/h265 并存）
 *   - Chromium 对文件名的硬性限制（非法字符会让整个下载调用失败）
 *
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeSegment, sanitizeStem, buildSafeFileName, renderTemplate, guessExtension, formatBytes, matchesMediaFilter, filterByMediaFilter, mediaFilterLabel, effectiveTemplate, saveStructureLabel, saveStructureName } from '../src/shared/utils';
import { originalImageUrl, jpegImageUrl, extractNote, extractNoteFromState, titleFromDesc } from '../src/content/detect/raw';
import { buildFileName, buildRelativePath, noteToMediaItems } from '../src/content/detect/media';
import { DEFAULT_SETTINGS } from '../src/shared/types';

/* ------------------------------------------------------------------ */
/* 文件名                                                              */
/* ------------------------------------------------------------------ */

test('sanitizeSegment：跨平台非法字符被替换', () => {
  assert.equal(sanitizeSegment('a:b*c?d"e<f>g|h'), 'a_b_c_d_e_f_g_h');
  assert.equal(sanitizeSegment('a\\b'), 'a_b');
});

test('sanitizeSegment：保留空格与中文', () => {
  assert.equal(sanitizeSegment('First time in forever'), 'First time in forever');
  assert.equal(sanitizeSegment('周末京都｜红叶季'), '周末京都｜红叶季');
});

test('sanitizeSegment：去掉结尾的空格与点（Chromium 拒绝）', () => {
  assert.equal(sanitizeSegment('trailing.'), 'trailing');
  assert.equal(sanitizeSegment('normal  '), 'normal');
});

test('sanitizeSegment：Windows 保留名加前缀', () => {
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('lpt1'), '_lpt1');
  assert.equal(sanitizeSegment('console'), 'console');
  // 实测：判据是「第一个点之前那段」，所以 con.jpg / con.tar.gz 都会被 Chromium 拒
  assert.equal(sanitizeSegment('con.jpg'), '_con.jpg');
  assert.equal(sanitizeSegment('con.tar.gz'), '_con.tar.gz');
  // 但 file.con.jpg 里的 con 不是词干，Chromium 是接受的
  assert.equal(sanitizeSegment('file.con.jpg'), 'file.con.jpg');
  // COM0 / COM10 不在保留名单里
  assert.equal(sanitizeSegment('com0.jpg'), 'com0.jpg');
  assert.equal(sanitizeSegment('com10.jpg'), 'com10.jpg');
});

test('sanitizeSegment：去掉前导点（Chromium 拒绝任何以 . 开头的路径段）', () => {
  assert.equal(sanitizeSegment('.隐藏文件.jpg'), '隐藏文件.jpg');
  assert.equal(sanitizeSegment('..foo.jpg'), 'foo.jpg');
  assert.equal(sanitizeSegment('.foo.bar.jpg'), 'foo.bar.jpg');
});

test('sanitizeSegment：摘掉 Shell 集成扩展名（Chromium 会整个拒掉）', () => {
  assert.equal(sanitizeSegment('我的收藏.url'), '我的收藏');
  assert.equal(sanitizeSegment('foo.lnk'), 'foo');
  assert.equal(sanitizeSegment('foo.scf'), 'foo');
  assert.equal(sanitizeSegment('foo.local'), 'foo');
  // 大小写不敏感
  assert.equal(sanitizeSegment('foo.URL'), 'foo');
  // 实测 .ade / .adp 是可用的，别乱删
  assert.equal(sanitizeSegment('foo.ade'), 'foo.ade');
  assert.equal(sanitizeSegment('foo.adp'), 'foo.adp');
  // 末位才是扩展名，"foo.url.jpg" Chromium 是接受的
  assert.equal(sanitizeSegment('foo.url.jpg'), 'foo.url.jpg');
});

test('sanitizeSegment：清掉控制字符与 Unicode 格式字符', () => {
  assert.equal(sanitizeSegment('a\u0000b'), 'a_b');
  assert.equal(sanitizeSegment('zero​width'), 'zerowidth');
  // emoji 变体选择符 U+FE0F 属于 \p{Cf}，留着会让 chrome.downloads.download 整个失败
  assert.equal(sanitizeSegment('🎨️ 春日'), '🎨 春日');
});

test('sanitizeSegment：空输入有兜底名', () => {
  assert.equal(sanitizeSegment(''), 'untitled');
  assert.equal(sanitizeSegment('   '), 'untitled');
});

test('buildSafeFileName：截断只切词干，扩展名必须完整', () => {
  const name = buildSafeFileName('很长的标题'.repeat(20), 'jpg', 80);
  assert.ok(name.endsWith('.jpg'), `扩展名被砍坏了: ${name}`);
  assert.ok(name.length <= 80, `长度超了: ${name.length}`);
});

test('buildSafeFileName：扩展名本身是 Shell 集成名时降级', () => {
  assert.ok(!buildSafeFileName('x', 'url').endsWith('.url'));
  assert.equal(buildSafeFileName('x', 'jpg'), 'x.jpg');
});

/* ------------------------------------------------------------------ */
/* 命名模板                                                            */
/* ------------------------------------------------------------------ */

test('renderTemplate：变量替换', () => {
  assert.equal(
    renderTemplate('{author}_{title}_{index}', { author: '小美', title: '咖啡', index: 2 }),
    '小美_咖啡_2',
  );
});

test('buildFileName：模板没写 {ext} 也会补上扩展名', () => {
  const name = buildFileName(
    { ...DEFAULT_SETTINGS, fileNameTemplate: '{author}_{title}_{index}' },
    { author: 'a', title: 'b', index: 0, ext: 'mp4' },
  );
  assert.equal(name, 'a_b_0.mp4');
});

test('buildFileName：默认模板是序号，路径不会和目录重复', () => {
  assert.equal(DEFAULT_SETTINGS.fileNameTemplate, '{index}');
  const name = buildFileName(DEFAULT_SETTINGS, { author: '小美', title: '咖啡', index: 1, ext: 'jpg' });
  assert.equal(name, '1.jpg');
});

test('buildFileName：模板写了 {ext} 就不重复追加', () => {
  const settings = { ...DEFAULT_SETTINGS, fileNameTemplate: '{title}.{ext}' };
  const name = buildFileName(settings, { title: '咖啡', index: 0, ext: 'jpg' });
  assert.equal(name, '咖啡.jpg');
});

test('buildFileName：{ext} 在模板中间也放对位置', () => {
  const settings = { ...DEFAULT_SETTINGS, fileNameTemplate: '{ext}_副本' };
  const name = buildFileName(settings, { title: '咖啡', index: 0, ext: 'jpg' });
  assert.ok(name.startsWith('jpg'), `扩展名位置不对: ${name}`);
  assert.ok(name.endsWith('_副本'), `尾巴丢了: ${name}`);
});

test('buildFileName：标题里带点不会被当成扩展名', () => {
  const settings = { ...DEFAULT_SETTINGS, fileNameTemplate: '{title}' };
  const name = buildFileName(settings, { title: '探店.v2', index: 0, ext: 'jpg' });
  assert.equal(name, '探店.v2.jpg');
});

test('buildRelativePath：按作者/标题建子目录', () => {
  const path = buildRelativePath(
    { settings: { ...DEFAULT_SETTINGS, rootFolder: '小红书下载' }, rootFolder: '小红书下载' },
    { author: '小美', title: '咖啡', filename: 'a.jpg' },
  );
  assert.equal(path, '小红书下载/小美/咖啡/a.jpg');
});

test('buildRelativePath：全部平铺时只留根目录', () => {
  const path = buildRelativePath(
    { settings: { ...DEFAULT_SETTINGS, rootFolder: '下载', saveStructure: 'flat' }, rootFolder: '下载' },
    { author: '小美', title: '咖啡', filename: 'a.jpg' },
  );
  assert.equal(path, '下载/a.jpg');
});

test('buildRelativePath：按作者分文件夹时保留作者那一层，不建标题子目录', () => {
  const path = buildRelativePath(
    { settings: { ...DEFAULT_SETTINGS, rootFolder: '下载', saveStructure: 'perAuthor' }, rootFolder: '下载' },
    { author: '小美', title: '咖啡', filename: '咖啡_1.jpg' },
  );
  assert.equal(path, '下载/小美/咖啡_1.jpg');
});

test('buildRelativePath：按作者分文件夹时作者为空也不留空目录', () => {
  const path = buildRelativePath(
    { settings: { ...DEFAULT_SETTINGS, rootFolder: '下载', saveStructure: 'perAuthor' }, rootFolder: '下载' },
    { filename: '1.jpg' },
  );
  assert.equal(path, '下载/1.jpg');
});

/* ------------------------------------------------------------------ */
/* 保存结构                                                            */
/* ------------------------------------------------------------------ */

test('effectiveTemplate：三种结构各用各的模板', () => {
  const perNote = { ...DEFAULT_SETTINGS, saveStructure: 'perNote' as const };
  const perAuthor = { ...DEFAULT_SETTINGS, saveStructure: 'perAuthor' as const };
  const flat = { ...DEFAULT_SETTINGS, saveStructure: 'flat' as const };
  assert.equal(effectiveTemplate(perNote), '{index}');
  assert.equal(effectiveTemplate(perAuthor), '{title}_{index}');
  assert.equal(effectiveTemplate(flat), '{author}_{title}_{index}');
});

test('按作者分文件夹的默认文件名带标题，不同笔记不会都叫 1.jpg', () => {
  const settings = { ...DEFAULT_SETTINGS, saveStructure: 'perAuthor' as const };
  const name = buildFileName(settings, { author: '小美', title: '咖啡', index: 1, ext: 'mp4' });
  assert.equal(name, '咖啡_1.mp4');
  assert.ok(!/^1\.mp4$/.test(name), '文件名不能只剩序号');
});

test('全部平铺的默认文件名带作者与标题，不会一堆文件都叫 1.mp4', () => {
  const settings = { ...DEFAULT_SETTINGS, saveStructure: 'flat' as const };
  const name = buildFileName(settings, { author: '小美', title: '咖啡', index: 1, ext: 'mp4' });
  assert.equal(name, '小美_咖啡_1.mp4');
  assert.ok(!/^1\.mp4$/.test(name), '文件名不能只剩序号');
});

test('全部平铺时身份由文件名承担，目录里不再建子文件夹', () => {
  const settings = { ...DEFAULT_SETTINGS, saveStructure: 'flat' as const, rootFolder: '下载' };
  const path = buildRelativePath(
    { settings, rootFolder: '下载' },
    { author: '小美', title: '咖啡', filename: '小美_咖啡_1.mp4' },
  );
  assert.equal(path, '下载/小美_咖啡_1.mp4');
});

test('saveStructureLabel：短标签（面板页签用）与长名称（说明文字用）', () => {
  assert.equal(saveStructureLabel('perNote'), '按笔记');
  assert.equal(saveStructureLabel('perAuthor'), '按作者');
  assert.equal(saveStructureLabel('flat'), '全部平铺');
  assert.equal(saveStructureName('perNote'), '独立文件夹');
  assert.equal(saveStructureName('perAuthor'), '按作者分文件夹');
  assert.equal(saveStructureName('flat'), '全部平铺');
});

/* ------------------------------------------------------------------ */
/* 标题识别（小红书有一部分笔记的 title 是空串）                       */
/* ------------------------------------------------------------------ */

test('titleFromDesc：标题为空时从正文首行推导', () => {
  assert.equal(
    titleFromDesc('男子陪即将离世的女儿谈笑聊天，接下来，把网友的眼泪都看出来了'),
    '男子陪即将离世的女儿谈笑聊天，接下来，把网友的眼泪都看出来了',
  );
});

test('titleFromDesc：正文首行是话题标签时不当标题', () => {
  assert.equal(titleFromDesc('#张诗婷[话题]##伤心大圆啵[话题]#'), '');
});

test('titleFromDesc：正文太长时不当标题', () => {
  assert.equal(titleFromDesc('这'.repeat(80)), '');
});

test('extractNote：title 是空串时用正文首行当标题', () => {
  const note = extractNote({
    noteId: '6ab98ed9000000001500e7b7',
    type: 'video',
    title: '',
    desc: '男子陪即将离世的女儿谈笑聊天，接下来，把网友的眼泪都看出来了',
  });
  assert.equal(note?.title, '男子陪即将离世的女儿谈笑聊天，接下来，把网友的眼泪都看出来了');
});

test('extractNote：标题为空时不会拿笔记编号顶替', () => {
  const note = extractNote({ noteId: '6ab98ed9000000001500e7b7', type: 'video', title: '' });
  assert.equal(note?.title, '');
});

test('noteToMediaItems：标题缺失时文件名里不出现笔记编号', () => {
  const note = extractNote({
    noteId: '6ab98ed9000000001500e7b7',
    type: 'video',
    title: '',
    desc: '',
    imageList: [IMAGE_ITEM],
  })!;
  const items = noteToMediaItems(note, DEFAULT_SETTINGS);
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.ok(
      !item.filename.includes('6ab98ed9000000001500e7b7'),
      `文件名里混进了笔记编号: ${item.filename}`,
    );
  }
});

test('noteToMediaItems：外部传入的标题优先（主页卡片标题比详情可靠）', () => {
  const note = extractNote({
    noteId: '6ab98ed9000000001500e7b7',
    type: 'video',
    title: '',
    desc: '',
    imageList: [IMAGE_ITEM],
  })!;
  const settings = { ...DEFAULT_SETTINGS, fileNameTemplate: '{title}_{index}' };
  const items = noteToMediaItems(note, settings, '来自列表卡片的标题');
  assert.equal(items[0]?.noteTitle, '来自列表卡片的标题');
  assert.ok(items[0]?.filename.includes('来自列表卡片的标题'), items[0]?.filename);
});

test('renderTemplate：变量为空时不会留下多余的分隔符', () => {
  assert.equal(
    renderTemplate('{author}_{title}_{index}', { author: '小美', title: '', index: 1 }),
    '小美_1',
  );
  assert.equal(
    renderTemplate('{author}_{title}_{index}', { author: '', title: '', index: 1 }),
    '1',
  );
});

/* ------------------------------------------------------------------ */
/* 图片 CDN 规则（实测得出）                                            */
/* ------------------------------------------------------------------ */

test('originalImageUrl：去掉 32 位 hex 签名目录', () => {
  const raw = 'http://sns-webpic-qc.xhscdn.com/202610241223/2c7562c0d27dcf0eb735015336666adf/1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8';
  assert.equal(
    originalImageUrl(raw),
    'https://sns-img-qc.xhscdn.com/1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8',
  );
});

test('originalImageUrl：保留业务目录段', () => {
  const raw = 'https://sns-img-qc.xhscdn.com/notes_pre_post/1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8';
  assert.equal(
    originalImageUrl(raw),
    'https://sns-img-qc.xhscdn.com/notes_pre_post/1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8',
  );
});

test('originalImageUrl：已是原图直链时幂等（不产生双斜杠）', () => {
  const once = 'https://sns-img-qc.xhscdn.com/1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8';
  assert.equal(originalImageUrl(once), once);
  assert.ok(!jpegImageUrl(once).includes('//1040'));
});

test('jpegImageUrl：加上 imageView2 参数', () => {
  const raw = 'http://sns-webpic-qc.xhscdn.com/202610241223/2c7562c0d27dcf0eb735015336666adf/1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8';
  assert.equal(
    jpegImageUrl(raw),
    'https://sns-img-qc.xhscdn.com/1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8?imageView2/format/jpeg',
  );
});

/* ------------------------------------------------------------------ */
/* 笔记提取                                                            */
/* ------------------------------------------------------------------ */

const STREAM_ENTRY = {
  masterUrl: 'http://sns-video-v6.xhscdn.com/stream/79/110/258/abc_258.mp4?sign=xx&t=1',
  backupUrls: ['http://sns-bak-v1.xhscdn.com/stream/79/110/258/abc_258.mp4'],
  duration: 21733,
  width: 720,
  height: 1280,
  size: 11366919,
  format: 'mp4',
};

const IMAGE_ITEM = {
  fileId: '1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8',
  width: 1440,
  height: 1921,
  urlDefault:
    'http://sns-webpic-qc.xhscdn.com/202610241223/2c7562c0d27dcf0eb735015336666adf/1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8',
  url: '',
  infoList: [{ imageScene: 'WB_DFT', url: 'http://example.com/cover.webp' }],
};

function makeState(buckets: Record<string, unknown[]>): any {
  return {
    note: {
      firstNoteId: '6ab1a4190000000035013fcf',
      noteDetailMap: {
        '6ab1a4190000000035013fcf': {
          note: {
            noteId: '6ab1a4190000000035013fcf',
            type: 'video',
            title: 'First time in forever',
            user: { nickname: 'evelyn' },
            interactInfo: { likedCount: 128 },
            imageList: [IMAGE_ITEM],
            video: { media: { stream: buckets } },
          },
        },
      },
    },
  };
}

test('extractNoteFromState：能取到图片与视频', () => {
  const note = extractNoteFromState(makeState({ h264: [STREAM_ENTRY] }), '6ab1a4190000000035013fcf');
  assert.ok(note);
  assert.equal(note!.author, 'evelyn');
  assert.equal(note!.title, 'First time in forever');
  assert.equal(note!.images.length, 1);
  assert.equal(note!.videos.length, 1);
});

test('extractNoteFromState：视频分桶名随版本变化都要认', () => {
  for (const key of ['h264', 'EF4', 'h265', 'EF5', 'av1']) {
    const note = extractNoteFromState(makeState({ [key]: [STREAM_ENTRY] }));
    assert.equal(note?.videos.length, 1, `分桶 ${key} 应该被识别`);
  }
});

test('extractNoteFromState：state 里没有目标笔记时返回 null', () => {
  assert.equal(extractNoteFromState(undefined), null);
  assert.equal(extractNoteFromState({}), null);
  assert.equal(extractNoteFromState({ note: { noteDetailMap: {} } }), null);
});

test('extractNoteFromState：指定 noteId 命中时优先返回那一条', () => {
  const state = makeState({ h264: [STREAM_ENTRY] });
  state.note.noteDetailMap['other-note-id'] = {
    note: { ...state.note.noteDetailMap['6ab1a4190000000035013fcf'].note, noteId: 'other-note-id', title: '另一条' },
  };
  const note = extractNoteFromState(state, 'other-note-id');
  assert.equal(note?.noteId, 'other-note-id');
  assert.equal(note?.title, '另一条');
});

test('extractNoteFromState：指定 noteId 命中不了时返回 null，绝不退回别的笔记', () => {
  // 回归测试：曾经这里会回退到状态里的任意一条，
  // 导致批量下载时把别的笔记当成了用户勾选的那条（静默下错内容）。
  const state = makeState({ h264: [STREAM_ENTRY] });
  assert.equal(extractNoteFromState(state, 'not-in-map'), null);
});

test('extractNoteFromState：不指定 noteId 时取页面当前这条', () => {
  const note = extractNoteFromState(makeState({ h264: [STREAM_ENTRY] }));
  assert.equal(note?.noteId, '6ab1a4190000000035013fcf');
});

test('extractNote：noteId 为 "undefined" 的脏数据要被跳过', () => {
  const note = extractNote({ noteId: 'undefined', imageList: [IMAGE_ITEM] });
  assert.equal(note, null);
});

test('视频优先用不带签名的 backup 地址', () => {
  const note = extractNoteFromState(makeState({ h264: [STREAM_ENTRY] }));
  assert.equal(note!.videos[0]!.url, 'https://sns-bak-v1.xhscdn.com/stream/79/110/258/abc_258.mp4');
});

/* ------------------------------------------------------------------ */
/* 媒体项                                                              */
/* ------------------------------------------------------------------ */

test('noteToMediaItems：视频与图片统一连续编号（1 起）', () => {
  const note = extractNoteFromState(makeState({ h264: [STREAM_ENTRY] }))!;
  const items = noteToMediaItems(note, DEFAULT_SETTINGS);
  assert.equal(items.length, 2);
  const video = items.find((i) => i.kind === 'video')!;
  const image = items.find((i) => i.kind === 'image')!;
  assert.ok(video.filename.endsWith('.mp4'));
  assert.ok(image.filename.endsWith('.jpg'));
  // 视频是 1，图片接着 2 —— 目录里排下来是 1.mp4、2.jpg
  assert.equal(video.filename, '1.mp4');
  assert.equal(image.filename, '2.jpg');
  assert.equal(image.url, 'https://sns-img-qc.xhscdn.com/1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8?imageView2/format/jpeg');
});

test('noteToMediaItems：选原图时不加 imageView2 参数', () => {
  const note = extractNoteFromState(makeState({ h264: [STREAM_ENTRY] }))!;
  const items = noteToMediaItems(note, { ...DEFAULT_SETTINGS, imageFormat: 'original' });
  const image = items.find((i) => i.kind === 'image')!;
  assert.equal(image.url, 'https://sns-img-qc.xhscdn.com/1040g2sg325d5f1ni4q005n341tr4na22ndh5mg8');
});

/* ------------------------------------------------------------------ */
/* 文件类型筛选                                                        */
/* ------------------------------------------------------------------ */

test('matchesMediaFilter：全部放行，视频/图片各管各的', () => {
  assert.equal(matchesMediaFilter('video', 'all'), true);
  assert.equal(matchesMediaFilter('image', 'all'), true);
  assert.equal(matchesMediaFilter('video', 'video'), true);
  assert.equal(matchesMediaFilter('image', 'video'), false);
  assert.equal(matchesMediaFilter('image', 'image'), true);
  assert.equal(matchesMediaFilter('video', 'image'), false);
});

test('文件类型筛选是全部文件的一个划分（视频 + 图片 = 全部）', () => {
  const items = [
    { kind: 'video' as const, id: 'v' },
    { kind: 'image' as const, id: 'cover' }, // 视频笔记的封面
    { kind: 'image' as const, id: 'i1' },
    { kind: 'image' as const, id: 'i2' },
  ];
  const all = filterByMediaFilter(items, 'all');
  const videos = filterByMediaFilter(items, 'video');
  const images = filterByMediaFilter(items, 'image');
  assert.equal(all.length, 4);
  assert.equal(videos.length, 1);
  assert.equal(images.length, 3);
  // 关键性质：两类加起来必须等于全部，否则用户会莫名少收文件
  assert.equal(videos.length + images.length, all.length);
});

test('只下载视频时，视频笔记的封面（图片项）会被跳过', () => {
  const note = extractNoteFromState(makeState({ h264: [STREAM_ENTRY] }))!;
  const items = noteToMediaItems(note, DEFAULT_SETTINGS);
  // 这条笔记既有 mp4 也有封面 jpg
  assert.equal(items.length, 2);
  const picked = filterByMediaFilter(items, 'video');
  assert.equal(picked.length, 1);
  assert.equal(picked[0]!.kind, 'video');
  assert.ok(picked[0]!.filename.endsWith('.mp4'));
});

test('mediaFilterLabel：中文名', () => {
  assert.equal(mediaFilterLabel('all'), '全部');
  assert.equal(mediaFilterLabel('video'), '视频');
  assert.equal(mediaFilterLabel('image'), '图片');
});

/* ------------------------------------------------------------------ */
/* 杂项                                                                */
/* ------------------------------------------------------------------ */

test('guessExtension：从 URL 推断扩展名', () => {
  assert.equal(guessExtension('https://x.com/a/b.mp4'), 'mp4');
  assert.equal(guessExtension('https://x.com/a/b.jpeg'), 'jpg');
  assert.equal(guessExtension('https://x.com/a/b', 'jpg'), 'jpg');
});

test('formatBytes：体积可读', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(11366919), '10.8 MB');
});
