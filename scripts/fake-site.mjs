/**
 * 假站点的「忠实度」工具。
 *
 * 为什么单独一个文件：假站点最大的风险是**比真站点干净** ——
 * 一旦假站点的形状跟真站点不一致，自动化测试全绿而线上照样坏。
 * 2026-10-24 就踩过这个坑：假站点用 `JSON.stringify` 写状态（纯 JSON），
 * 而真站点的 `__INITIAL_STATE__` 是**JavaScript 对象字面量**（含 `undefined`），
 * 于是「抓 HTML」那条快路在测试里永远走通、在真站点上永远走不通。
 *
 * 所以这里的每个函数都按真站点的实测行为写。
 */

/** 状态里代表 `undefined` 的占位符（序列化时会被换成真的 undefined） */
export const UNDEF = '__RN_UNDEFINED__';

/**
 * 把状态写成真站点那种「JavaScript 对象字面量」。
 *
 * 真站点的状态里有 `undefined`（实测 2026-10-24：explore 页 29 处），
 * 所以它**不是合法 JSON** —— 直接 `JSON.parse` 必然抛错。
 * 扩展必须能容错解析，这条规则用占位符实现。
 */
export function serializeState(state) {
  return JSON.stringify(state).replace(/"__RN_UNDEFINED__"/g, 'undefined');
}

/**
 * 笔记页的 HTML。
 *
 * @param note    这条笔记
 * @param detail  笔记详情（媒体直链都在里面）
 * @param ssrDetail
 *   true  —— SSR 的 HTML 里就带详情（快路能走通）
 *   false —— SSR 的 HTML 里**没有**详情，详情由页面脚本过一会儿补上。
 *            这模拟真站点未登录时的情形：详情是页面 JS 用 XHR 拉的，
 *            服务端渲染的 HTML 里没有（实测 2026-10-24）。
 * @param detailPath
 *   详情在状态里的位置。**站点改版时这个位置会变** ——
 *   'noteDetailMap' 是常见形状，'currentNote' 模拟「换了个地方放」，
 *   扩展必须照样找得到（不能因为位置变了就一条都解析不出来）。
 * @param viaApi
 *   true —— 详情**只**从接口拿（页面自己 XHR 一次），
 *           而且**不写进 __INITIAL_STATE__**（模拟站点搬进了 store）。
 *           扩展只能从抓到的接口响应里把笔记找出来。
 * @param viaApiXhr
 *   true —— 同上，但用 **XMLHttpRequest + responseType: 'json'** 来拿。
 *           真站点用 axios，走的就是这条路（实测 2026-10-25：站点打包了 library-axios）。
 *           特意带上 responseType 是因为：这时读 xhr.responseText **会抛**
 *           （InvalidStateError），扩展要是只读 responseText，这条路就断了。
 */
export function notePageHtml({
  note,
  detail,
  ssrDetail = true,
  delayMs = 250,
  detailPath = 'noteDetailMap',
  viaApi = false,
  viaApiXhr = false,
}) {
  const state = {
    note: {
      prevRouteData: {},
      prevRoute: 'Empty',
      commentTarget: {},
      isImgFullscreen: false,
      gotoPage: '',
      firstNoteId: note.id,
      autoOpenNote: false,
      topCommentId: '',
      highlightDescTexts: [],
      // 真站点这里是空对象（未登录时拿不到详情）
      noteDetailMap:
        ssrDetail && !viaApi && !viaApiXhr && detailPath === 'noteDetailMap'
          ? { [note.id]: { note: detail } }
          : {},
      serverRequestInfo: { state: 'success', errorCode: 0, errMsg: '' },
      volume: 0,
      recommendVideoMap: {},
      videoFeedType: 'note_source',
      rate: 1,
      // 真站点这里就是 undefined —— 纯 JSON 序列化会把它丢掉
      currentNoteId: UNDEF,
      forceScrollToComment: false,
      mediaWidth: 450,
      noteHeight: 800,
      redFirstNoteId: '',
    },
    nioStore: { collectionListDataSource: UNDEF, error: UNDEF },
    groupData: { error: null },
  };

  // 详情被挪到了另一个位置（站点改版）
  if (ssrDetail && !viaApi && !viaApiXhr && detailPath === 'currentNote') {
    state.note.currentNote = { note: detail };
  }

  // 详情只从接口来，而且不写进状态
  const apiFetch = viaApi
    ? `
<script>
  // 模拟页面自己去接口拿详情（真实站点就是这么干的）
  fetch('/api/sns/web/v1/feed?note_id=' + encodeURIComponent(${JSON.stringify(note.id)}))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      window.__rednoteFeedData = data;
    });
</script>`
    : '';

  // 同上，但走 axios 那种 XHR + responseType: 'json' 的路
  const apiXhr = viaApiXhr
    ? `
<script>
  // 真实站点用 axios：XHR + responseType: 'json'。
  // 这时 xhr.responseText 读不了（会抛），只有 xhr.response 拿得到。
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/sns/web/v1/feed?note_id=' + encodeURIComponent(${JSON.stringify(note.id)}));
  xhr.responseType = 'json';
  xhr.onload = function () { window.__rednoteFeedData = xhr.response; };
  xhr.send();
</script>`
    : '';

  // 「SSR 里没有详情」时，页面脚本过一会儿把详情补进状态
  const lateFill =
    !ssrDetail && !viaApi && !viaApiXhr
      ? `
<script>
  // 模拟页面自己的 XHR 回来之后把详情补进状态里
  setTimeout(function () {
    window.__INITIAL_STATE__.note.noteDetailMap[${JSON.stringify(note.id)}] =
      { note: ${JSON.stringify(detail)} };
  }, ${delayMs});
</script>`
      : '';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${note.title} - 小红书</title>
<script>window.__INITIAL_STATE__ = ${serializeState(state)};</script>${lateFill}${apiFetch}${apiXhr}
</head><body><div id="app"></div></body></html>`;
}

/**
 * 笔记详情接口的响应（页面自己 XHR 拿到的那份）。
 *
 * 形状按真站点：外层是 `{data: {items: [{id, note_card: {...}}]}}`，
 * 媒体在 note_card 里、id 在外层。
 */
export function feedApiJson(note, detail) {
  return {
    success: true,
    data: {
      items: [
        {
          id: note.id,
          xsec_token: 'fake-token',
          note_card: detail,
        },
      ],
    },
  };
}

/**
 * 分开统计「页面导航」与「脚本抓取」。
 *
 * 扩展解析一条笔记有两条路：
 *   - 抓 HTML：content script 里的 fetch() → Sec-Fetch-Dest: empty
 *   - 隐藏 iframe：真实的页面导航 → Sec-Fetch-Dest: iframe
 *
 * 分开数这两个，才能验证「没有对每条笔记都白打一次 fetch」。
 */
export function makeRequestCounter() {
  const counter = { fetch: 0, iframe: 0, other: 0 };
  const record = (req) => {
    const dest = String(req.headers['sec-fetch-dest'] || '');
    if (dest === 'iframe') counter.iframe += 1;
    else if (dest === 'empty') counter.fetch += 1;
    else counter.other += 1;
  };
  return { counter, record };
}
