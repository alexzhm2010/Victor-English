/* ============================================================
 * 背单词工具 前端逻辑
 * 两种运行模式：
 *  - 演示模式(demo)：用 window.DEMO_DATA，数据存 localStorage，双击即用
 *  - 在线模式：通过 Supabase REST API 上传图片、查词库，
 *              调用 Edge Function(scan-page) 完成 AI 拆解入库
 * ============================================================ */

const LS = {
  cfg:      'vocab_cfg',
  demo:     'vocab_demo_words',
  progress: 'vocab_scan_progress',   // { [book]: maxPageNo } 扫描进度记忆
};

/* ============================================================
 * 版本与更新日志（集中维护：每次改完功能，只需在这里加一条）
 * 最新一条放在数组最前面，首页会显示其版本号 + 更新要点。
 * ============================================================ */
const CHANGELOG = [
  { v: '2.2.2', date: '2026-11-17', items: [
    '修复漏词：AI 偶尔把多个单词嵌套进前一个词的结构里，导致只入库少数词；现自动打平提取全部词条',
    '实测第6页由 2 词恢复为 12 词，提示词同步强化「词条必须平级」',
  ]},
  { v: '2.2.1', date: '2026-11-17', items: [
    '新增「重扫此页」：已录入页漏词时用原页码重新识别并覆盖，不再误导改页码',
    '重扫先清该页旧词条再入库，页码不变、数据不错乱',
  ]},
  { v: '2.2.0', date: '2026-11-17', items: [
    '新增跨页「握手池」：残段常驻数据库，任意顺序/任意时间间隔录入都能自动补全',
    '先录后页再补前页：页首残段入池，前页录入后自动反向合并',
    '握手信息按「页码+头/尾」唯一存储，重复扫描不产生重复数据',
  ]},
  { v: '2.1.9', date: '2026-11-17', items: [
    '修复失败重试：网络超时实际已入库时自动纠正为成功，不再误报失败',
    '修复跨页词：重试/跳过失败页后，从数据库承接半截词并自动合并下一页',
  ]},
  { v: '2.1.8', date: '2026-11-17', items: [
    '修复重复解析：同一词重扫后词性带点/不带点生成两套义项，导致中文释义与例句重复',
    '词性归一合并义项，例句按英文去重，释义取更完整的一条',
  ]},
  { v: '2.1.7', date: '2026-11-17', items: [
    '版本卡片只显示当前版本，移除历史版本列表',
    '精简各页辅助说明文字，界面更清爽',
  ]},
  { v: '2.1.6', date: '2026-11-17', items: [
    '扫描页版本信息卡片移到页面最底部，顶部直接是拍摄/选图框',
  ]},
  { v: '2.1.5', date: '2026-11-17', items: [
    '修复词库 tab 角标位置：改为紧贴图标右上角，不再飘离',
  ]},
  { v: '2.1.4', date: '2026-11-17', items: [
    '页眉改为「维克多背单词」，只保留版本号',
    '滚动时页眉滑出、搜索框吸顶锁定，列表继续滚动',
  ]},
  { v: '2.1.3', date: '2026-11-17', items: [
    '搜索结果数改为分数形式（搜索数/总数），表头更简洁',
  ]},
  { v: '2.1.2', date: '2026-11-17', items: [
    '取消高考词频 Rⁿ 小标（识别不准且对背词意义不大）',
    '词库页排版压紧：字号缩小、间距收紧，一页显示更多单词',
    '表头精简：搜索框与统计合并一行，移除使用提示条',
  ]},
  { v: '2.1.1', date: '2026-11-17', items: [
    '移除词卡上的编辑笔按钮，统一用长按/右键编辑，界面更简洁',
  ]},
  { v: '2.1.0', date: '2026-11-17', items: [
    '录入重构：单页独立处理，失败可随时单独重试，不再卡全局',
    '浏览页改为仿书本单列排版，按 A–Z 无限滚动、自动预加载',
    '新增长按编辑：改音标/释义、打学习标签（不会/不熟/已掌握/自定义）',
    '新增标签彩色徽标与搜索框旁的标签快捷筛选',
  ]},
  { v: '2.0.0', date: '2026-11-17', items: [
    '按整书版式规则重写解析提示词，准确度大幅提升',
    '新增身份符号(课标外/增补/删减/派生)、高考词频Rⁿ识别',
    '新增义项级英文释义、义项深浅(常考/低频)标注',
    '新增「辨/注/同」标签框解析与展示',
    '▶派生词独立成词条并与母词建立关联',
  ]},
  { v: '1.8.0', date: '2026-11-16', items: [
    '首页只留一个「开始识别入库」按钮',
    '拍照改为可连续拍摄：拍完存队列、界面不退出，点完成才返回',
  ]},
  { v: '1.7.0', date: '2026-11-16', items: [
    '拍照/选图改为先存列表等待（最多15张），点按钮才统一提交解析',
  ]},
  { v: '1.6.0', date: '2026-11-16', items: [
    '新增「高考链接」真题方块自动跳过，不解析、不入库',
  ]},
  { v: '1.5.0', date: '2026-11-16', items: [
    '省流优化：上传前压缩图片、精简提示词、命中前缀缓存',
  ]},
  { v: '1.4.0', date: '2026-11-16', items: [
    '弹框简化为单个「开始」按钮',
    '识别页码后自动判断「前期已录入」并跳过，避免重复扫描',
  ]},
  { v: '1.3.0', date: '2026-11-16', items: [
    '进度缓存 + 网络重试，解决进度慢与 Failed to fetch 误报',
  ]},
  { v: '1.2.0', date: '2026-11-16', items: [
    '一键自动：识别页码→按序入库合并为一步',
    '业务表初始化，正式录入前数据清零',
  ]},
  { v: '1.1.0', date: '2026-11-16', items: [
    '页码改为从图片印刷页码识别入库（不再按拍照顺序累增）',
    '新增 detect-page 页码识别函数',
  ]},
  { v: '1.0.0', date: '2026-11-16', items: [
    '首版：拍照上传 → AI 扫描拆解入库 → 查询词库',
    '三层数据模型 words → senses → examples',
  ]},
];

function renderVersion() {
  const latest = CHANGELOG[0];
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('headerVersion', 'v' + latest.v);
  set('versionBadge', 'v' + latest.v);
  set('versionDate', latest.date + ' 更新');
  const latestBox = document.getElementById('versionLatest');
  if (latestBox) latestBox.innerHTML = latest.items.map(x => '<div class="vitem">• ' + esc(x) + '</div>').join('');
}
function toggleChangelog() {
  const h = document.getElementById('versionHistory');
  const t = document.getElementById('versionToggle');
  if (!h) return;
  const open = h.classList.toggle('open');
  if (t) t.textContent = open ? '收起 ▴' : '历史版本 ▾';
}

let cfg = loadCfg();
let allWords = [];   // 当前词库列表
let lastMaxPage = 0;        // 上次扫描到的最大页码（权威来源：vw_scan_batches 表）
let expectedStartPage = null; // 弹框选的“接下来拍第几页”，仅作 AI 识别页码的软提示，绝不用于分配页码

/* ---------------- 配置 ---------------- */
function loadCfg() {
  try {
    return Object.assign(
      { url: 'https://gjtjivmxxelnousbqmok.supabase.co',
      key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqdGppdm14eGVsbm91c2JxbW9rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzOTExOTAsImV4cCI6MjEwMDk2NzE5MH0.RjURzDQWye9V68YE9ngKejNmDrg-DQcFlwF_QbgFRsM',
      book: 'victor', demo: false },
      JSON.parse(localStorage.getItem(LS.cfg) || '{}')
    );
  } catch (e) { return { url: '', key: '', book: 'victor', demo: true }; }
}
function saveCfg() {
  localStorage.setItem(LS.cfg, JSON.stringify(cfg));
}
function saveSettings() {
  cfg.url  = document.getElementById('cfgUrl').value.trim().replace(/\/$/, '');
  cfg.key  = document.getElementById('cfgKey').value.trim();
  cfg.book = document.getElementById('cfgBook').value.trim() || 'victor';
  saveCfg();
  applyMode();
  setStatus('设置已保存', 'ok');
  toast('设置已保存');
  if (!cfg.demo) refreshWords();
  updateProgressDisplay();
}
function toggleDemo() {
  cfg.demo = !cfg.demo;
  document.getElementById('demoSwitch').classList.toggle('on', cfg.demo);
  saveCfg();
  applyMode();
  toast(cfg.demo ? '已切换到演示模式' : '已切换到在线模式');
  refreshWords();
  updateProgressDisplay();
}
function applyMode() {
  const badge = document.getElementById('modeBadge');
  if (badge) {
    badge.textContent = cfg.demo ? '演示模式' : '在线模式';
    badge.className = 'mode-badge' + (cfg.demo ? ' demo' : '');
  }
  const sub = document.getElementById('headerSub');
  if (sub) sub.textContent =
    cfg.demo ? '内置样例 · 数据存本机' : (cfg.url ? cfg.url.replace(/^https?:\/\//,'') : '未配置 Supabase');
  const hint = document.getElementById('scanHint');
  if (hint) hint.style.display = cfg.demo ? 'block' : 'none';
}
function setStatus(msg, type) {
  const el = document.getElementById('statusLine');
  el.textContent = msg;
  el.className = 'status-line' + (type ? ' ' + type : '');
}
async function testConnection() {
  // 先把输入框里的值读进来（即使未点保存也能测试）
  cfg.url  = document.getElementById('cfgUrl').value.trim().replace(/\/$/, '');
  cfg.key  = document.getElementById('cfgKey').value.trim();
  cfg.book = document.getElementById('cfgBook').value.trim() || 'victor';
  if (!cfg.url || !cfg.key) { setStatus('请先填写 URL 和 anon key', 'err'); return; }
  setStatus('正在连接…', '');
  try {
    const r = await fetch(`${cfg.url}/rest/v1/vw_books?select=id&limit=1`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` }
    });
    if (r.ok) { setStatus('连接成功 ✓ 可切换到在线模式', 'ok'); applyMode(); }
    else {
      const t = await r.text();
      setStatus(`连接失败 ${r.status}：${t.slice(0,120)}`, 'err');
    }
  } catch (e) { setStatus('网络错误：' + e.message, 'err'); }
}

/* ---------------- 导航 ---------------- */
function switchPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.page === name));
  if (name === 'words') resetWordList();
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ---------------- 网络请求：超时 + 自动重试 ---------------- */
// 手机网络下长时间请求易被中断（表现为 "Failed to fetch"）。
// 统一封装：每次请求带超时，网络类错误自动重试，最终失败给出可读中文提示。
async function fetchWithRetry(url, opts = {}, { timeout = 25000, retries = 2, label = '网络请求' } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const r = await fetch(url, { ...opts, ...(ctrl ? { signal: ctrl.signal } : {}) });
      if (timer) clearTimeout(timer);
      return r;   // 拿到 HTTP 响应即返回（4xx/5xx 由调用方判断）
    } catch (e) {
      if (timer) clearTimeout(timer);
      lastErr = e;
      const isAbort = e && e.name === 'AbortError';
      // 网络层错误（Failed to fetch / 超时）才重试；主动中断不重试
      const retryable = !isAbort && /failed to fetch|network|load failed|timeout/i.test(String(e && e.message || e));
      if (attempt < retries && retryable) {
        await new Promise(res => setTimeout(res, 700 * (attempt + 1)));
        continue;
      }
      throw new Error(`${label}失败：${isAbort ? '请求超时，请检查网络' : (e && e.message || '网络连接中断')}`);
    }
  }
  throw new Error(`${label}失败：${lastErr && lastErr.message || '网络连接中断'}`);
}

/* ---------------- 扫描进度记忆（最大页码） ---------------- */
// 本地进度（按 book 区分），作为数据库查询失败时的兜底
function loadLocalProgress() {
  try {
    const all = JSON.parse(localStorage.getItem(LS.progress) || '{}');
    return all[cfg.book] || 0;
  } catch (e) { return 0; }
}
function saveLocalProgress(pageNo) {
  if (!pageNo || pageNo <= 0) return;
  try {
    const all = JSON.parse(localStorage.getItem(LS.progress) || '{}');
    all[cfg.book] = Math.max(all[cfg.book] || 0, pageNo);
    localStorage.setItem(LS.progress, JSON.stringify(all));
  } catch (e) {}
  lastMaxPage = Math.max(lastMaxPage, pageNo);
}
// 从「存储每页页码的表」vw_scan_batches 读取真实最大页码（权威来源，唯一依据）
// 会话内缓存：同一本书只查一次，避免页面初始化 + 每次点拍照都重复请求（进度慢的根因）
let _progressCache = { key: null, value: 0 };
async function fetchLastMaxPage(force = false) {
  const cacheKey = `${cfg.url}|${cfg.book}|${cfg.demo}`;
  if (!force && _progressCache.key === cacheKey) {
    lastMaxPage = _progressCache.value;
    return lastMaxPage;
  }
  if (cfg.demo || !cfg.url || !cfg.key) {
    lastMaxPage = 0; _progressCache = { key: cacheKey, value: 0 };
    return 0;
  }
  try {
    const r = await fetchWithRetry(
      `${cfg.url}/rest/v1/vw_scan_batches?book_id=eq.${encodeURIComponent(cfg.book)}&select=page_no&order=page_no.desc&limit=1`,
      { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } },
      { timeout: 12000, retries: 1, label: '读取扫描进度' }
    );
    if (r.ok) {
      const rows = await r.json();
      lastMaxPage = rows.length ? (rows[0].page_no || 0) : 0;
      _progressCache = { key: cacheKey, value: lastMaxPage };
      return lastMaxPage;
    }
  } catch (e) { console.warn(e.message); }
  // 查询失败也不能卡住弹框：返回上次已知值或 0
  return (_progressCache.key === cacheKey ? _progressCache.value : 0);
}
/* ---------------- 已录入页码查询（用于「前期已录入」标注与跳过） ---------------- */
// 以词表 vw_words 的 page_no 为准：该页存在词条即视为「前期已录入」
let _recordedCache = { key: null, set: null };
async function fetchRecordedPages(force = false) {
  const cacheKey = `${cfg.url}|${cfg.book}|${cfg.demo}`;
  if (!force && _recordedCache.key === cacheKey && _recordedCache.set) return _recordedCache.set;
  if (cfg.demo) {
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem(LS.demo) || '[]'); } catch (e) {}
    const set = new Set(stored.map(w => w.page_no).filter(n => n > 0));
    _recordedCache = { key: cacheKey, set };
    return set;
  }
  if (!cfg.url || !cfg.key) {
    _recordedCache = { key: cacheKey, set: new Set() };
    return _recordedCache.set;
  }
  try {
    const r = await fetchWithRetry(
      `${cfg.url}/rest/v1/vw_words?book_id=eq.${encodeURIComponent(cfg.book)}&select=page_no`,
      { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } },
      { timeout: 15000, retries: 1, label: '查询已录入页码' }
    );
    if (r.ok) {
      const rows = await r.json();
      const set = new Set(rows.map(x => x.page_no).filter(n => n > 0));
      _recordedCache = { key: cacheKey, set };
      return set;
    }
  } catch (e) { console.warn(e.message); }
  _recordedCache = { key: cacheKey, set: new Set() };
  return _recordedCache.set;
}
// 识别完页码后，给每张图标注「该页前期是否已录入」
async function markRecordedPages() {
  const recorded = await fetchRecordedPages();
  batchQueue.forEach(it => {
    it.recorded = it.pageNo > 0 && recorded.has(it.pageNo);
  });
}
// 入库成功后让缓存失效，下次读取会拉到最新页码 / 最新已录入集合
function invalidateProgressCache() { _progressCache.key = null; _recordedCache.key = null; }

// 假失败复查：网络超时/中断时，服务端可能已把词条写入再回传响应失败。
// 这里强制查一次词库该页是否已有词条，有则判定"其实已成功入库"。
async function isPageActuallyRecorded(pageNo) {
  if (!(pageNo > 0) || cfg.demo || !cfg.url || !cfg.key) return false;
  try {
    const r = await fetchWithRetry(
      `${cfg.url}/rest/v1/vw_words?book_id=eq.${encodeURIComponent(cfg.book)}&page_no=eq.${pageNo}&select=id&limit=1`,
      { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } },
      { timeout: 12000, retries: 1, label: '复查该页入库状态' }
    );
    if (!r.ok) return false;
    const data = await r.json();
    invalidateProgressCache();   // 允许下次 markRecordedPages 拿到最新集合
    return Array.isArray(data) && data.length > 0;
  } catch (e) { return false; }
}

// 从「握手池」读取某页页尾的 pending 残段，构造跨页上下文。
// 残段常驻 vw_page_handshakes，不依赖内存 nextContext，
// 因此即使上一页是很久前录的、失败重试补录的、中间隔了很多页，下一页仍能拿到半截词信息。
// （后端 scan-page 也会主动查同一张池表，这里传参是双保险。）
async function loadPageContext(pageNo) {
  if (!(pageNo > 0) || cfg.demo || !cfg.url || !cfg.key) return null;
  try {
    const r = await fetchWithRetry(
      `${cfg.url}/rest/v1/vw_page_handshakes?book_id=eq.${encodeURIComponent(cfg.book)}`
        + `&page_no=eq.${pageNo}&side=eq.tail&status=eq.pending`
        + `&select=page_no,headword,payload&order=id.desc`,
      { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } },
      { timeout: 12000, retries: 1, label: '读取跨页握手池' }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    const partial_words = rows
      .filter(x => x.headword)
      .map(x => ({ headword: x.headword, senses: Array.isArray(x.payload) ? x.payload : [] }));
    if (!partial_words.length) return null;
    return { page_no: pageNo, partial_words };
  } catch (e) { return null; }
}

// 重试某页成功后，若它产生页尾半截词、且下一页已在本次队列中，
// 自动用本页上下文重新解析下一页一次，把跨页词合并成一条（带防循环标志，不递归向下）。
let _repairingNext = false;
async function autoRepairNextPage(item, result) {
  if (_repairingNext || !result) return;
  const partials = result.partial_words || [];
  if (!partials.length || !(item.pageNo > 0)) return;
  const nextNo = item.pageNo + 1;
  const nextItem = batchQueue.find(x => x !== item && x.pageNo === nextNo);
  if (!nextItem) return;   // 下一页不在队列，无法自动补全；残段已在握手池，日后录入会自动合并
  if (nextItem.status === 'done' && !nextItem.error) return;  // 下一页已成功入库，幂等跳过（后端已按池合并）
  _repairingNext = true;
  try {
    const ctx = result.nextContext || { page_no: item.pageNo, partial_words: partials };
    await parseOnePage(nextItem, nextNo, ctx, batchQueue.indexOf(nextItem));
    invalidateProgressCache();
    toast(`第 ${item.pageNo} 页跨页词「${partials.join('、')}」已自动并入第 ${nextNo} 页`);
  } catch (e) {
    toast(`第 ${item.pageNo} 页跨页词未能自动合并，可重扫第 ${nextNo} 页：${e.message}`);
  } finally {
    _repairingNext = false;
  }
}
// 刷新扫描页常驻进度条
function updateProgressDisplay() {
  fetchLastMaxPage().then(() => {
    const el = document.getElementById('lastProgress');
    if (el) el.textContent = lastMaxPage > 0
      ? `📖 上次扫描到第 ${lastMaxPage} 页` : '📖 尚无扫描记录，将从第 1 页开始';
  });
}

/* ---------------- 扫描进度提示弹框 ---------------- */
let scanPromptSource = 'camera';   // 'camera' | 'file'

// 拍照/选图前先弹进度提示
async function openScanPrompt(source) {
  scanPromptSource = source;
  const mask = document.getElementById('scanPrompt');
  mask.classList.add('show');
  document.getElementById('spTitle').textContent = '读取扫描进度…';
  document.getElementById('spDesc').textContent = '正在查询上次扫描到的页码';
  document.getElementById('spChoices').innerHTML = '';
  const n = await fetchLastMaxPage();
  renderScanPrompt(n);
}
function renderScanPrompt(n) {
  const maxPage = n > 0 ? n : 0;
  const title = document.getElementById('spTitle');
  const desc = document.getElementById('spDesc');
  const choices = document.getElementById('spChoices');
  if (maxPage > 0) {
    title.innerHTML = `上次扫描到<span class="modal-highlight">第 ${maxPage} 页</span>`;
    desc.innerHTML = '选择或拍照上传后，页码会以每页<strong>实际印刷的页码</strong>为准自动识别；已录入过的页码会在清单里标注「前期已录入」并自动跳过。';
  } else {
    title.textContent = '开始第一次扫描';
    desc.innerHTML = '选择或拍照上传后，页码会从每页自动识别，识别后可在缩略图上校正。';
  }
  // 只有一个「开始」按钮：点击后进入选图/拍照，页码一律从图片识别，不再做页码选择
  choices.innerHTML = `
    <div class="modal-choice primary" onclick="proceedScan()">
      <span class="ci">▶️</span><span><b>开始</b><small>${scanPromptSource === 'camera' ? '进入相机，可连续拍多张后一起提交' : '从相册选多张图片，一起提交'}</small></span>
    </div>`;
}
function closeScanPrompt() {
  document.getElementById('scanPrompt').classList.remove('show');
}
function proceedScan() {
  closeScanPrompt();
  // 页码一律从图片上识别，不再用「上次页码」做软提示
  expectedStartPage = null;
  setTimeout(() => {
    if (scanPromptSource === 'camera') {
      openCamera();          // 自定义相机：可持续连拍，拍完不退出
    } else {
      document.getElementById('fileInput').click();   // 相册多选
    }
  }, 100);
}

/* ---------------- 自定义相机（连续拍照） ---------------- */
let camStream = null;      // 当前摄像头 MediaStream
let camShots = 0;          // 本次打开相机已拍张数

// 打开相机：持续取景，点快门抓帧入队，界面不退出，可连拍；点「完成」才关闭。
async function openCamera() {
  const modal = document.getElementById('cameraModal');
  const video = document.getElementById('camVideo');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // 不支持 getUserMedia（如非安全上下文），回退到系统相机
    toast('当前环境不支持连续拍照，已切换到系统相机');
    document.getElementById('cameraInput').click();
    return;
  }
  modal.classList.add('show');
  updateCamCount();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = camStream;
    await video.play();
    document.getElementById('camStatus').textContent = '对准页面，点快门拍照；可连续拍';
  } catch (e) {
    // 权限拒绝/无摄像头：回退系统相机
    modal.classList.remove('show');
    toast('无法打开连续拍照，已切换到系统相机');
    document.getElementById('cameraInput').click();
  }
}

// 快门：从 video 抓一帧 → canvas → JPEG File → 入队（静默），界面保持打开
function snapPhoto() {
  const video = document.getElementById('camVideo');
  if (!video || !video.videoWidth) { toast('相机画面还没准备好'); return; }
  if (batchQueue.length >= MAX_BATCH) {
    toast(`最多只能排队 ${MAX_BATCH} 张，请点「完成」后提交`);
    return;
  }
  const canvas = document.createElement('canvas');
  // 长边限制 1920，与上传压缩一致，省 token
  const maxSide = 1920;
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(blob => {
    if (!blob) { toast('拍照失败，请重试'); return; }
    const file = new File([blob], `camera_${Date.now()}_${camShots + 1}.jpg`, { type: 'image/jpeg' });
    const n = enqueueFiles([file], { silent: true });
    if (n > 0) {
      camShots += n;
      updateCamCount();
      flashShutter();           // 快门视觉反馈
      toast(`已存入第 ${camShots} 张，可继续拍`);
    }
  }, 'image/jpeg', 0.82);
}

function updateCamCount() {
  const el = document.getElementById('camCount');
  if (el) el.textContent = `本次已拍 ${camShots} 张 · 队列 ${batchQueue.length}/${MAX_BATCH}`;
}

function flashShutter() {
  const f = document.getElementById('camFlash');
  if (!f) return;
  f.classList.remove('flash');
  void f.offsetWidth;           // 触发重排以重启动画
  f.classList.add('flash');
}

// 完成：停止摄像头、关闭界面，回到主页（照片已在队列里）
function closeCamera() {
  const modal = document.getElementById('cameraModal');
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  const video = document.getElementById('camVideo');
  if (video) video.srcObject = null;
  modal.classList.remove('show');
  camShots = 0;
  if (batchQueue.length) {
    toast(`共拍 ${batchQueue.length} 张已存列表，点「开始识别并入库」统一提交`);
  }
}

/* ---------------- 批量扫描 ---------------- */
const MAX_BATCH = 15;      // 一次最多排队 15 张
let batchQueue = [];   // [{id, file, thumb, status, result, error, pageNo, recorded}]
let batchRunning = false;

const fileInput = document.getElementById('fileInput');
const cameraInput = document.getElementById('cameraInput');
fileInput.addEventListener('change', e => addFiles(e.target.files));
cameraInput.addEventListener('change', e => addFiles(e.target.files));

// 把文件对象放进队列的核心逻辑；返回实际入队数量。
// opts.silent=true 时不弹 toast（连拍时由相机界面自己提示）。
function enqueueFiles(fileList, opts = {}) {
  const files = Array.from(fileList || []).filter(f => f.type.startsWith('image/'));
  if (!files.length) return 0;
  const room = MAX_BATCH - batchQueue.length;
  if (room <= 0) {
    if (!opts.silent) toast(`最多只能排队 ${MAX_BATCH} 张，请先提交或清空当前列表`);
    return 0;
  }
  const accepted = files.slice(0, room);   // 超出上限的部分丢弃
  for (const f of accepted) {
    batchQueue.push({
      id: 'q' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      file: f,
      thumb: URL.createObjectURL(f),
      status: 'pending',
      result: null,
      error: null,
      pageNo: 0,        // 不猜、不累增；由 AI 从图片上识别真实印刷页码
      imageUrl: null,
      imagePath: null,
      batchId: null,
    });
  }
  document.getElementById('resultCard').classList.remove('show');
  renderBatch();
  const dropped = files.length - accepted.length;
  if (!opts.silent) {
    toast(`已保存 ${accepted.length} 张到列表${dropped ? `（超出上限，忽略 ${dropped} 张）` : ''}，点下方按钮一起提交`);
  }
  return accepted.length;
}

function addFiles(fileList) {
  const n = enqueueFiles(fileList);
  // 选图路径只存列表等待，不自动解析；由用户点「开始识别并入库」统一提交
  fileInput.value = '';
  cameraInput.value = '';
  return n;
}

// 页码输入框变更
function setPageNo(id, val) {
  const item = batchQueue.find(x => x.id === id);
  if (!item || item.running) return;
  const old = item.pageNo;
  item.pageNo = Math.max(0, parseInt(val, 10) || 0);
  // 页码被手动改动后，旧的「已录入」判断失效，需重新评估
  if (item.pageNo !== old) item.recorded = false;
  renderBatch();
}

function renderBatch() {
  const list = document.getElementById('batchList');
  const head = document.getElementById('batchHead');
  const actions = document.getElementById('batchActions');
  if (!batchQueue.length) {
    list.innerHTML = '';
    head.style.display = 'none';
    actions.style.display = 'none';
    return;
  }
  head.style.display = 'flex';
  document.getElementById('batchCount').textContent = `已选 ${batchQueue.length} 页`;
  actions.style.display = 'flex';
  const statusText = {
    pending: '待处理', uploading: '上传中…',
    detecting: '<span class="mini-spinner"></span> AI 识别页码中…',
    detected: '✓ 页码已识别', parsing: '<span class="mini-spinner"></span> AI 解析中…',
    done: '✓ 完成', error: '✗ 失败', retrying: '<span class="mini-spinner"></span> 重试中…',
    recorded: '◷ 前期已录入（跳过）',
  };
  list.innerHTML = batchQueue.map((it, i) => {
    const running = !!it.running;
    // 前期已录入优先显示，不再走普通解析状态（带自定义 note 的完成项除外，用 note 说明）
    const hasNote = it.status === 'done' && it.result && it.result.note;
    const isRecorded = it.recorded && it.pageNo > 0 && it.status !== 'error' && !hasNote;
    const st = isRecorded ? statusText.recorded : (statusText[it.status] || it.status);
    let extra = '';
    if (hasNote) {
      extra = `<div class="boundary-note recorded">✅ ${esc(it.result.note)}</div>`;
    } else if (isRecorded) {
      extra = `<div class="boundary-note recorded">📖 第 ${it.pageNo} 页已在词库中，本次自动跳过。若漏录了单词，点右侧「重扫」会用原页码重新识别并覆盖本页。</div>`;
    } else if (it.status === 'detected' && it.pageNo > 0) {
      extra = `<div class="boundary-note">📖 从图片识别到第 ${it.pageNo} 页，可点左侧页码校正</div>`;
    }
    if (it.error && it.status === 'error') {
      extra += `<div class="boundary-note partial">${esc(it.error)}</div>`;
    }
    if (it.status === 'done' && it.result && !hasNote) {
      extra = `<div class="batch-status">识别 ${it.result.words_found || 0} 词 / ${it.result.examples_found || 0} 例句${it.result.merged_examples ? ` · 合并 ${it.result.merged_examples} 条` : ''}</div>`;
      if (it.result.resumed_words) {
        extra += `<div class="boundary-note">🔗 补全上一页半截词 ${it.result.resumed_words} 个</div>`;
      }
      const pw = it.result.partial_words || [];
      if (pw.length) {
        extra += `<div class="boundary-note partial">⏳ 页尾半截词「${pw.map(esc).join('、')}」已暂存，下页自动补全</div>`;
      }
    }
    const statusCls = isRecorded ? 'recorded' : (it.status === 'error' ? 'error' : it.status);
    const pageVal = it.pageNo || '';
    const pgInput = running
      ? `<span class="pg-tag">P${it.pageNo || '?'}</span>`
      : `<span class="pg-wrap">P<input class="pg-input" type="number" min="0" value="${pageVal}" placeholder="页码" onchange="setPageNo('${it.id}',this.value)" onclick="event.stopPropagation()"></span>`;
    // 单页操作按钮：失败可重试、未开始可单独启动、已录入可强制重扫。均不依赖全局 batchRunning。
    let runBtn = '';
    if (isRecorded && !running) {
      // 已录入页：给「重扫」按钮，用原页码重新识别并覆盖，不改页码、不错页
      runBtn = `<button class="batch-run retry" title="用原页码重新识别并覆盖本页" onclick="forceRescan('${it.id}')">重扫</button>`;
    } else if (!isRecorded) {
      if (it.status === 'error') {
        runBtn = `<button class="batch-run retry" onclick="runOnePage('${it.id}')" ${running ? 'disabled' : ''}>重试</button>`;
      } else if (it.status === 'pending' || it.status === 'detected') {
        runBtn = `<button class="batch-run" onclick="runOnePage('${it.id}')" ${running ? 'disabled' : ''}>▶</button>`;
      } else if (running) {
        runBtn = `<button class="batch-run" disabled>…</button>`;
      }
    }
    return `<div class="batch-item">
      <img class="batch-thumb" src="${it.thumb}" alt="">
      <div class="batch-info">
        <div class="batch-name">${pgInput} ${esc(it.file.name)}</div>
        <div class="batch-status ${statusCls}">${st}</div>
        ${extra}
      </div>
      ${runBtn}
      <button class="batch-del" onclick="removeOne('${it.id}')" ${running ? 'disabled' : ''}>×</button>
    </div>`;
  }).join('');
  const autoBtn = document.getElementById('autoBtn');
  if (autoBtn) {
    autoBtn.disabled = batchRunning;
    const recordedCount = batchQueue.filter(x => x.recorded && x.pageNo > 0).length;
    autoBtn.textContent = batchRunning ? '批量处理中…（失败页可单独重试）'
      : `🚀 开始识别并入库（${batchQueue.length}/${MAX_BATCH} 张${recordedCount ? `，${recordedCount} 张已录入将跳过` : ''}）`;
  }
}

function removeOne(id) {
  const it = batchQueue.find(x => x.id === id);
  if (it && it.running) return;   // 正在处理的页不允许删除；空闲/失败页随时可删
  batchQueue = batchQueue.filter(x => x.id !== id);
  renderBatch();
}
function clearBatch() {
  if (batchQueue.some(x => x.running)) { toast('有页面正在处理，请稍候再清空'); return; }
  batchQueue = [];
  renderBatch();
  document.getElementById('progressBox').classList.remove('show');
}

function setProgress(show, pct, label) {
  const box = document.getElementById('progressBox');
  box.classList.toggle('show', show);
  document.getElementById('progressBar').style.width = (pct || 0) + '%';
  if (label) document.getElementById('progressLabel').textContent = label;
}

/* ---- 省流①：上传前压缩图片，降低多模态图片输入 token ----
 * 词典页文字密集，不能压太狠；长边上限 1920px + JPEG 0.85 在“看清字”和“省 token”间取平衡。
 * detail:high 的图片 token 随分辨率上升，压缩后整页扫描 input token 明显下降。
 * 已足够小 / 压缩失败时回退原图，绝不影响可用性。
 */
const IMG_MAX_SIDE = 1920;
const IMG_QUALITY = 0.82;
function compressImage(file, maxSide = IMG_MAX_SIDE, quality = IMG_QUALITY) {
  return new Promise((resolve) => {
    if (!file || !file.type.startsWith('image/')) return resolve(file);
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const { width, height } = img;
        const longest = Math.max(width, height);
        // GIF 直接保留（可能动图）；已够小且是 jpeg 也直接保留
        if (file.type === 'image/gif' || (longest <= maxSide && file.type === 'image/jpeg')) {
          URL.revokeObjectURL(objUrl);
          return resolve(file);
        }
        const scale = longest > maxSide ? maxSide / longest : 1;
        const w = Math.round(width * scale), h = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(objUrl);
          if (!blob) return resolve(file);
          const out = new File([blob],
            file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
          resolve(out);
        }, 'image/jpeg', quality);
      } catch (e) {
        URL.revokeObjectURL(objUrl);
        resolve(file);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); resolve(file); };
    img.src = objUrl;
  });
}

/* ---- 阶段①：逐张上传 + AI 识别真实印刷页码 + 落库到 vw_scan_batches ---- */
async function uploadOne(item) {
  if (!cfg.url || !cfg.key) throw new Error('请先在设置中配置 Supabase');
  // 省流①：压缩后再上传，detect 与 scan 复用这张压缩图（只压一次，两处受益）
  const uploadFile = await compressImage(item.file);
  item.uploadBytes = uploadFile.size;
  const path = `vocab-pages/${cfg.book}/${Date.now()}_${uploadFile.name.replace(/[^\w.\-]/g, '_')}`;
  const up = await fetchWithRetry(`${cfg.url}/storage/v1/object/${path}`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': uploadFile.type || 'image/jpeg' },
    body: uploadFile,
  }, { timeout: 60000, retries: 2, label: '图片上传' });
  if (!up.ok) throw new Error('图片上传失败 ' + up.status);
  return { path, imageUrl: `${cfg.url}/storage/v1/object/public/${path}` };
}

async function detectPageOne(item) {
  const fn = await fetchWithRetry(`${cfg.url}/functions/v1/detect-page`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageUrl: item.imageUrl, imagePath: item.imagePath,
      bookId: cfg.book, batchId: item.batchId || null,
      expectedPage: expectedStartPage,
    }),
  }, { timeout: 90000, retries: 1, label: '页码识别' });
  const text = await fn.text();
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error('页码识别返回异常：' + text.slice(0, 150)); }
  if (!fn.ok || !d.ok) throw new Error(d.error || ('页码识别失败 ' + fn.status));
  return d;  // { ok, page_no, batch_id, raw }
}

/* ---- 阶段①核心：对单页上传 + AI 识别真实页码 ----
 * 传入单个 item，独立设置 running，失败抛错由调用方决定如何处理。
 */
async function detectOnePage(item) {
  if (item.imageUrl && item.pageNo > 0) return;   // 已识别过，跳过
  item.running = true;
  item.status = 'uploading';
  item.error = null;
  renderBatch();
  try {
    if (cfg.demo) {
      await new Promise(r => setTimeout(r, 300));
      item.pageNo = 100 + batchQueue.indexOf(item);  // 演示模式占位页码
      item.imageUrl = item.thumb;
      item.batchId = null;
    } else {
      const up = await uploadOne(item);
      item.imagePath = up.path;
      item.imageUrl = up.imageUrl;
      item.status = 'detecting';
      renderBatch();
      const d = await detectPageOne(item);
      item.pageNo = d.page_no || 0;
      item.batchId = d.batch_id || item.batchId || null;
      if (!d.page_no) throw new Error('未识别到页码，请在左侧手动填写页码');
    }
    item.status = 'detected';
  } finally {
    item.running = false;
  }
}

/* ---- 阶段①批量：逐张识别页码（调 detectOnePage）---- */
async function detectAllPages() {
  setProgress(true, 0, '准备识别页码…');
  const total = batchQueue.length;
  for (let i = 0; i < total; i++) {
    const item = batchQueue[i];
    setProgress(true, Math.round(i / total * 100), `第 ${i + 1}/${total} 张：识别页码…`);
    try {
      await detectOnePage(item);
    } catch (e) {
      item.status = 'error';
      item.error = e.message;
    }
    renderBatch();
  }
  batchQueue.sort((a, b) => (a.pageNo || 99999) - (b.pageNo || 99999));
  await markRecordedPages();
  renderBatch();
  const okCount = batchQueue.filter(x => x.pageNo > 0).length;
  return { okCount, total };
}

/* ---- 阶段②核心：对单页解析入库（独立 running），prevContext 为跨页上下文 ---- */
async function parseOnePage(item, pageNo, prevContext, index, force = false) {
  item.running = true;
  item.status = 'parsing';
  item.error = null;
  renderBatch();
  try {
    let result;
    if (cfg.demo) result = await demoScanOne(index || 0, prevContext);
    else result = await scanOneOnline(item, pageNo, prevContext, force);
    item.status = 'done';
    item.result = result;
    saveLocalProgress(pageNo);
    invalidateProgressCache();          // 页码已入库，缓存失效以便下次读取最新值
    return result;
  } finally {
    item.running = false;
  }
}

/* ---- 阶段②批量：按页码升序逐页扫描，跨页上下文传递；单页失败不阻塞后续 ---- */
async function scanAllPages() {
  batchQueue.sort((a, b) => (a.pageNo || 99999) - (b.pageNo || 99999));
  renderBatch();
  let nextContext = null;
  const summary = [];
  // 前期已录入的页跳过；页码没识别出来的也跳过
  const all = batchQueue.filter(x => x.pageNo > 0 && !x.recorded);
  const skippedRecorded = batchQueue.filter(x => x.pageNo > 0 && x.recorded).length;
  const total = all.length;
  setProgress(true, 0, '准备入库…');
  for (let i = 0; i < total; i++) {
    const item = all[i];
    const pageNo = item.pageNo;
    if (item.status === 'done' && item.result) {
      summary.push(item.result);
      nextContext = item.result.nextContext || nextContext;
      continue;
    }
    setProgress(true, Math.round(i / total * 100), `第 ${pageNo} 页（${i + 1}/${total}）：AI 解析入库中…`);
    try {
      // 上下文双来源：优先用同批次内存 nextContext，否则从握手池读上一页 pending 残段。
      // 这样即使上一页隔很久才录、或本批次不含相邻页，也能接上跨页词。
      let ctx = nextContext;
      if (!ctx || ctx.page_no !== pageNo - 1) {
        ctx = await loadPageContext(pageNo - 1) || ctx;
      }
      const result = await parseOnePage(item, pageNo, ctx, i);
      summary.push(result);
      if (result && result.nextContext) nextContext = result.nextContext;
    } catch (e) {
      // 假失败复查：网络超时可能服务端已入库，若该页已有词则纠正为成功
      if (await isPageActuallyRecorded(pageNo)) {
        item.status = 'done';
        item.error = null;
        item.result = { ok: true, words_found: null, note: '服务端已入库成功，仅为回传超时（无需重试）' };
      } else {
        item.status = 'error';
        item.error = e.message;
      }
    }
    renderBatch();
  }
  await refreshWords();
  const failed = all.filter(x => x.status === 'error').length;
  return { total, failed, summary, skippedRecorded };
}

// 收尾：进度、结果卡片、提示
function finishScanUI(total, failed, summary, skipped = 0, skippedRecorded = 0) {
  setProgress(true, 100, '全部完成');
  setTimeout(() => setProgress(false), 800);
  showBatchResult(summary);
  updateProgressDisplay();
  const parts = [];
  if (failed) parts.push(`${failed} 页失败（点状态可重试）`);
  if (skippedRecorded) parts.push(`${skippedRecorded} 页前期已录入被跳过`);
  if (skipped) parts.push(`${skipped} 页未识别出页码被跳过（手动补页码后重试）`);
  toast(parts.length ? `完成：${parts.join('，')}` : `全部 ${total} 页按页码顺序入库完成`);
}

/* ---- 入口①：仅识别页码（供手动校正）---- */
async function startDetectPages() {
  if (batchRunning || !batchQueue.length) return;
  batchRunning = true;
  renderBatch();
  try {
    const { okCount, total } = await detectAllPages();
    setProgress(true, 100, `页码识别完成 ${okCount}/${total}`);
    setTimeout(() => setProgress(false), 1200);
    updateProgressDisplay();
    toast(`已识别 ${okCount}/${total} 页页码，可校正后点“扫描入库”`);
  } catch (e) {
    setProgress(false);
    toast('识别异常：' + e.message);
  } finally {
    batchRunning = false;
    renderBatch();
  }
}

/* ---- 入口②：仅按已识别页码入库（手动校正路径）---- */
async function startBatchScan() {
  if (batchRunning || !batchQueue.length) return;
  if (!batchQueue.some(x => x.pageNo > 0)) { toast('请先识别每页页码'); return; }
  batchRunning = true;
  renderBatch();
  try {
    const { total, failed, summary, skippedRecorded } = await scanAllPages();
    finishScanUI(total, failed, summary, 0, skippedRecorded);
  } catch (e) {
    setProgress(false);
    toast('批量处理异常：' + e.message);
  } finally {
    batchRunning = false;
    renderBatch();
  }
}

/* ---- 入口③：一键自动 —— 识别页码 → 按页码排序 → 逐页扫描入库 ----
 * 批量运行中，若某页失败，用户可立即点该页「重试」按钮（runOnePage），
 * 不依赖 batchRunning，也不阻塞其它页继续处理。
 */
async function autoRunAll() {
  if (batchRunning || !batchQueue.length) return;
  batchRunning = true;
  renderBatch();
  try {
    const { okCount, total } = await detectAllPages();
    if (okCount === 0) {
      setProgress(false);
      toast('未能从图片识别出页码，请在缩略图上手动填写页码后重试');
      return;
    }
    setProgress(true, 100, `页码识别完成 ${okCount}/${total}，开始按页码顺序扫描入库…`);
    const { total: scanned, failed, summary, skippedRecorded } = await scanAllPages();
    finishScanUI(scanned, failed, summary, total - okCount, skippedRecorded);
  } catch (e) {
    setProgress(false);
    toast('自动扫描异常：' + e.message);
  } finally {
    batchRunning = false;
    renderBatch();
  }
}

/* ---- 单页全流程：只处理这一页（上传→识别页码→解析入库），随时可单独启动/重试 ----
 * 关键：不看 batchRunning，只看 item.running。因此批量处理中失败页也能立即重试。
 */
async function runOnePage(id) {
  const item = batchQueue.find(x => x.id === id);
  if (!item || item.running) return;
  item.error = null;
  try {
    setProgress(true, 0, `单独处理第 ${item.pageNo || '?'} 页…`);
    // 1) 页码未识别则先识别
    if (!(item.imageUrl && item.pageNo > 0)) {
      await detectOnePage(item);
    }
    // 2) 检查是否前期已录入（含"本次假失败其实已入库"的情况）
    await markRecordedPages();
    if (item.pageNo > 0 && item.recorded) {
      item.status = 'done';
      item.error = null;
      item.result = { ok: true, words_found: null, note: `已确认第 ${item.pageNo} 页词条已在词库中，无需重扫` };
      renderBatch();
      toast(`第 ${item.pageNo} 页已成功入库（此前失败提示为网络误报），已标记完成`);
      return;
    }
    if (!item.pageNo) throw new Error('未识别到页码，请在左侧手动填写页码');
    // 3) 解析入库。带上"上一页"的跨页上下文（从数据库读取，孤立重试也能正确承接页首词）
    const prevCtx = await loadPageContext(item.pageNo - 1);
    const result = await parseOnePage(item, item.pageNo, prevCtx, batchQueue.indexOf(item));
    item.result = result;
    // 4) 若本页产生页尾半截词，且下一页已在队列，自动重扫下一页合并跨页词
    await autoRepairNextPage(item, result);
    setProgress(true, 100, `第 ${item.pageNo} 页完成`);
    toast(`第 ${item.pageNo} 页处理完成：${result.words_found || 0} 词`);
  } catch (e) {
    // 假失败复查：若服务端其实已入库，纠正为成功而非失败
    if (await isPageActuallyRecorded(item.pageNo)) {
      item.status = 'done';
      item.error = null;
      item.result = { ok: true, words_found: null, note: '服务端已入库成功，仅为回传超时（无需重试）' };
      toast(`第 ${item.pageNo} 页其实已成功入库（网络误报），已标记完成`);
    } else {
      item.status = 'error';
      item.error = e.message;
      toast(`处理失败：${e.message}`);
    }
  } finally {
    item.running = false;
    renderBatch();
    await refreshWords();
    setTimeout(() => setProgress(false), 1200);
  }
}

/* ---- 强制重扫：已录入页发现漏词时，用原页码重新识别并覆盖本页 ----
 * 不改页码（避免数据错页），后端 force=1 会先清空该页旧词条再重新入库。
 */
async function forceRescan(id) {
  const item = batchQueue.find(x => x.id === id);
  if (!item || item.running) return;
  if (!(item.pageNo > 0)) { toast('该页还没有页码，无法重扫'); return; }
  item.error = null;
  try {
    setProgress(true, 0, `强制重扫第 ${item.pageNo} 页（原页码覆盖）…`);
    const prevCtx = await loadPageContext(item.pageNo - 1);
    const result = await parseOnePage(item, item.pageNo, prevCtx, batchQueue.indexOf(item), true);
    item.recorded = false;
    await autoRepairNextPage(item, result);
    setProgress(true, 100, `第 ${item.pageNo} 页重扫完成`);
    toast(`第 ${item.pageNo} 页已重扫覆盖：识别 ${result.words_found || 0} 词${result.force_cleared ? `（清除旧词 ${result.force_cleared} 条）` : ''}`);
  } catch (e) {
    item.status = 'error';
    item.error = e.message;
    toast(`重扫失败：${e.message}`);
  } finally {
    item.running = false;
    renderBatch();
    await refreshWords();
    setTimeout(() => setProgress(false), 1200);
  }
}

/* ---- 在线：解析一页（图片与页码已在阶段①上传/识别，批次已落库）---- */
async function scanOneOnline(item, pageNo, prevContext, force = false) {
  if (!cfg.url || !cfg.key) throw new Error('请先在设置中配置 Supabase');
  if (!item.imageUrl) throw new Error('图片尚未上传，请先执行“识别每页页码”');
  // 一页 AI 解析约 40 秒，超时放宽到 150 秒；网络中断自动重试 1 次（入库幂等，重试安全）
  // force=1 时后端会先清该页旧数据，因此网络重试也必须带 force，否则第二次重试会跳过清理
  const fn = await fetchWithRetry(`${cfg.url}/functions/v1/scan-page`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageUrl: item.imageUrl, bookId: cfg.book, pageNo,
      batchId: item.batchId, prevContext, force,
    }),
  }, { timeout: 150000, retries: 1, label: `第 ${pageNo} 页扫描` });
  const text = await fn.text();
  let result;
  try { result = JSON.parse(text); } catch (e) { throw new Error('函数返回异常：' + text.slice(0, 200)); }
  if (!fn.ok || !result.ok) throw new Error(result.error || ('扫描函数失败 ' + fn.status));
  return result;
}

/* ---- 演示模式：模拟单页，仍传递上下文 ---- */
async function demoScanOne(index, prevContext) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(500);
  const demo = window.DEMO_DATA || { words: [] };
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem(LS.demo) || '[]'); } catch (e) {}
  const map = new Map(stored.map(w => [w.headword, w]));
  let added = 0, senses = 0, examples = 0;
  for (const w of demo.words) {
    senses += (w.senses || []).length;
    for (const s of (w.senses || [])) {
      examples += (s.items || []).reduce((n, it) => n + 1 + (it.children ? it.children.length : 0), 0);
    }
    if (!map.has(w.headword)) added++;
    map.set(w.headword, Object.assign({}, w, { page_no: w.page_no || 123, book_id: cfg.book }));
  }
  localStorage.setItem(LS.demo, JSON.stringify(Array.from(map.values())));
  return {
    ok: true, words_found: demo.words.length, senses_found: senses,
    examples_found: examples, words: demo.words.map(w => w.headword),
    boundary: { tail: { word: 'day', note: '演示：day 义项延续到下一页' } },
    nextContext: { word: 'day', note: '演示上下文', senses: [] },
  };
}

/* ---- 单页重试（兼容旧调用）：统一走单页全流程，只重跑这一页 ---- */
function retryOne(id) {
  item_reset_for_retry(id);
  runOnePage(id);
}
function item_reset_for_retry(id) {
  const item = batchQueue.find(x => x.id === id);
  if (!item) return;
  item.status = 'pending';
  item.error = null;
  item.result = null;
  // 若页码是识别失败（0），清掉标记让 runOnePage 重新识别；手动填的页码(>0)保留
  if (!item.pageNo) { item.imageUrl = null; item.imagePath = null; }
  renderBatch();
}

/* ---- 批量结果汇总展示 ---- */
function showBatchResult(summary) {
  const card = document.getElementById('resultCard');
  card.classList.add('show');
  const wSet = new Set();
  let senses = 0, examples = 0, merged = 0, resumed = 0;
  const partials = [];
  summary.forEach(r => {
    (r.words || []).forEach(w => wSet.add(w));
    senses += r.senses_found || 0;
    examples += r.examples_found || 0;
    merged += r.merged_examples || 0;
    resumed += r.resumed_words || 0;
    (r.partial_words || []).forEach(p => partials.push(p));
  });
  document.getElementById('resultStats').innerHTML = `
    <span>处理 ${summary.length} 页</span>
    <span>去重词条 ${wSet.size}</span>
    <span>义项 ${senses}</span>
    <span>例句 ${examples}</span>
    ${merged ? `<span>合并去重 ${merged}</span>` : ''}
    ${resumed ? `<span>补全半截词 ${resumed}</span>` : ''}`;
  let bHtml = '';
  if (resumed) bHtml += `<div class="boundary-note">🔗 已用上一页上下文补全 ${resumed} 个半截词（义项例句并入原页）</div>`;
  if (partials.length) bHtml += `<div class="boundary-note partial">⏳ 页尾半截词「${Array.from(new Set(partials)).join('、')}」已暂存并标记，扫描下一页时会自动补全</div>`;
  document.getElementById('boundarySummary').innerHTML = bHtml;
  document.getElementById('resultChips').innerHTML =
    Array.from(wSet).map(w => `<span class="chip">${esc(w)}</span>`).join('');
}

/* ---------------- 词库查询 ---------------- */
// 词性归一化：去掉末尾句点（adj./adj. → adj），与后端 normPos 保持一致
function normPosFront(p) { return String(p || '').trim().replace(/\.+$/, '').toLowerCase(); }
// 中文释义"纯度"评分：中文越多、英文越少越高，用于从重复义项里挑正确释义
function hanScore(s) {
  const str = String(s || '');
  if (!str.trim()) return -1;
  const han = (str.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (str.match(/[A-Za-z]/g) || []).length;
  return han - latin * 2;
}
// 显示层去重：同一词多次扫描会因词性带点/不带点产生重复义项（adj vs adj.），
// 按「归一化词性|义项号」合并：释义取中文最纯的、常考标取任一条、例句按英文去重合并
function dedupeSenses(senses) {
  if (!Array.isArray(senses)) return [];
  const groups = new Map();
  for (const s of senses) {
    const no = s.sense_no ?? s.no ?? 0;
    const key = normPosFront(s.pos) + '|' + no;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const out = [];
  for (const arr of groups.values()) {
    // 主义项取 id 最大者（新批次提示词更准），保留其 id 供长按编辑写回
    let base = arr.reduce((a, b) => (Number(b.id) || 0) > (Number(a.id) || 0) ? b : a, arr[0]);
    base = Object.assign({}, base);
    // 中文释义取中文纯度最高的一条
    let best = arr[0];
    for (const s of arr) if (hanScore(s.chinese_def || s.def) > hanScore(best.chinese_def || best.def)) best = s;
    if (hanScore(best.chinese_def || best.def) >= 0) base.chinese_def = best.chinese_def || best.def || base.chinese_def;
    // 常考标：任一条为高频则保留
    if (arr.some(s => Number(s.sense_freq) === 1)) base.sense_freq = 1;
    // 补齐其它字段
    for (const f of ['countability', 'usage_label', 'english_def', 'antonym']) {
      if (!base[f]) { const hit = arr.find(s => s[f]); if (hit) base[f] = hit[f]; }
    }
    // 例句：跨重复义项按英文去重合并
    const seen = new Set(); const ex = [];
    for (const s of arr) {
      for (const e of (s.examples || s.items || [])) {
        const k = String(e.en || '').toLowerCase().replace(/[\s\p{P}]/gu, '');
        if (k && seen.has(k)) continue;
        if (k) seen.add(k);
        ex.push(e);
      }
    }
    base.examples = ex;
    out.push(base);
  }
  return out;
}

async function refreshWords() {
  if (cfg.demo) {
    try { allWords = JSON.parse(localStorage.getItem(LS.demo) || '[]'); }
    catch (e) { allWords = []; }
  } else {
    if (!cfg.url || !cfg.key) { allWords = []; return; }
    // 嵌套查询：vw_words 带出 vw_senses(再带 vw_examples) 与 vw_notes
    const select = 'id,headword,phonetic,level_tag,page_no,partial,inline_def,identity_tag,derived_from,parent_word_id,tags,vw_senses(id,pos,sense_no,sense_freq,countability,usage_label,chinese_def,english_def,antonym,vw_examples(id,kind,parent_phrase,usage_label,en,zh,gloss,source)),vw_notes(id,note_type,title,content)';
    const r = await fetchWithRetry(`${cfg.url}/rest/v1/vw_words?book_id=eq.${encodeURIComponent(cfg.book)}&select=${encodeURIComponent(select)}&order=id`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` }
    }, { timeout: 20000, retries: 1, label: '加载词库' });
    if (!r.ok) { console.warn('查询词库失败', await r.text()); allWords = []; return; }
    const rows = await r.json();
    // Supabase 嵌套返回键为 vw_senses / vw_examples，归一化为前端统一结构
    allWords = rows.map(w => Object.assign({}, w, {
      tags: Array.isArray(w.tags) ? w.tags : [],
      senses: (w.vw_senses || []).map(s => Object.assign({}, s, {
        examples: s.vw_examples || []
      })),
      notes: w.vw_notes || []
    }));
  }
  // 统一归一化：tags 数组 + 义项去重（消除重复扫描产生的 adj/adj. 双份义项）
  allWords.forEach(w => {
    if (!Array.isArray(w.tags)) w.tags = [];
    w.senses = dedupeSenses(w.senses);
  });
  // 按 A–Z 排序（忽略大小写），供仿书本顺序滚动
  allWords.sort((a, b) => String(a.headword || '').toLowerCase().localeCompare(String(b.headword || '').toLowerCase()));
  rebuildTagFilter();
  resetWordList();
  updateBadge();
}
function updateBadge() {
  const b = document.getElementById('navBadge');
  b.textContent = allWords.length;
  b.classList.toggle('show', allWords.length > 0);
}

/* ---------------- 词库浏览：仿书本 · 单列无限滚动 · 搜索 · 标签筛选 ---------------- */
const PAGE_RENDER = 30;                 // 每批渲染词条数（预加载 1~2 屏篇幅）
let filteredWords = [];                 // 当前搜索+标签过滤后的列表
let renderedCount = 0;                  // 已渲染条数
let activeTag = '__all__';              // 当前标签筛选
let _sentinelObserver = null;

// 搜索框输入（防抖）
let _searchTimer = null;
function onSearchChange() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(resetWordList, 180);
}

// 依据搜索词 + 当前标签，计算过滤后的列表
function computeFiltered() {
  const q = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  return allWords.filter(w => {
    // 标签筛选
    if (activeTag !== '__all__' && !(w.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    // 模糊搜索：英文单词 + 中文释义（含例句中文，容错）
    if ((w.headword || '').toLowerCase().includes(q)) return true;
    return (w.senses || []).some(s =>
      (s.chinese_def || s.def || '').includes(q) ||
      (s.examples || s.items || []).some(e => (e.en || '').toLowerCase().includes(q) || (e.zh || '').includes(q))
    );
  });
}

// 重新计算并从头渲染
function resetWordList() {
  filteredWords = computeFiltered();
  renderedCount = 0;
  const host = document.getElementById('wordList');
  host.innerHTML = '';
  const q = (document.getElementById('searchInput').value || '').trim();
  // 分数形式：分子 = 搜索/筛选后的数量，分母 = 全部数量
  document.getElementById('listSummary').innerHTML =
    `<b>${filteredWords.length}</b><span class="frac-sep">/</span>${allWords.length}`;
  const sentinel = document.getElementById('scrollSentinel');
  if (!filteredWords.length) {
    sentinel.classList.add('hidden');
    host.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
      <div>${q || activeTag !== '__all__' ? '没有匹配的单词' : '词库为空，先去扫描一页吧'}</div></div>`;
    return;
  }
  sentinel.classList.remove('hidden');
  appendWords();
  setupSentinelObserver();
}

// 追加下一批词条
function appendWords() {
  if (renderedCount >= filteredWords.length) {
    document.getElementById('scrollSentinel').classList.add('hidden');
    return;
  }
  const batch = filteredWords.slice(renderedCount, renderedCount + PAGE_RENDER);
  const host = document.getElementById('wordList');
  host.insertAdjacentHTML('beforeend', batch.map((w, k) => wordCardHtml(w, renderedCount + k)).join(''));
  renderedCount += batch.length;
  if (renderedCount >= filteredWords.length) {
    document.getElementById('scrollSentinel').textContent = '— 已显示全部 —';
  } else {
    document.getElementById('scrollSentinel').innerHTML = '<span class="mini-spinner"></span> 加载更多…';
  }
}

// 滚动到底自动加载（IntersectionObserver）
function setupSentinelObserver() {
  if (_sentinelObserver) { _sentinelObserver.disconnect(); _sentinelObserver = null; }
  if (typeof IntersectionObserver === 'undefined') return;   // 老浏览器兜底：用户可点哨兵
  const sentinel = document.getElementById('scrollSentinel');
  _sentinelObserver = new IntersectionObserver(entries => {
    entries.forEach(en => { if (en.isIntersecting) appendWords(); });
  }, { rootMargin: '200px' });
  _sentinelObserver.observe(sentinel);
}

// 重建标签筛选 chips
function rebuildTagFilter() {
  const PRESET = ['不会', '不熟', '已掌握'];
  const counts = {};
  allWords.forEach(w => (w.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  // 自定义标签 = 出现过且非预置
  const customs = Object.keys(counts).filter(t => !PRESET.includes(t)).sort();
  if (activeTag !== '__all__' && !PRESET.includes(activeTag) && !customs.includes(activeTag)) activeTag = '__all__';
  const dot = c => `<span class="dot" style="background:${c}"></span>`;
  let html = `<button class="tag-chip ${activeTag === '__all__' ? 'active' : ''}" data-tag="__all__" onclick="setActiveTag('__all__')">全部</button>`;
  PRESET.forEach(t => {
    if (counts[t]) html += `<button class="tag-chip ${activeTag === t ? 'active' : ''}" data-tag="${t}" onclick="setActiveTag('${t}')">${dot(t==='不会'?'#dc2626':t==='不熟'?'#ea580c':'#16a34a')}${t} ${counts[t]}</button>`;
  });
  customs.forEach(t => {
    html += `<button class="tag-chip ${activeTag === t ? 'active' : ''}" data-tag="${esc(t)}" onclick="setActiveTag('${esc(t)}')">${dot('#7c3aed')}${esc(t)} ${counts[t]}</button>`;
  });
  document.getElementById('tagFilter').innerHTML = html;
}
function setActiveTag(tag) {
  activeTag = tag;
  rebuildTagFilter();
  resetWordList();
}

// 词卡：供 render 使用（保留原展示，附加标签徽标 + 长按/编辑按钮）
function wordCardHtml(w, i) {
  const senses = (w.senses || []).map(s => {
    // 兼容演示数据(no/usage/def)与在线数据(sense_no/usage_label/chinese_def)两套命名
    const senseNo    = s.sense_no ?? s.no ?? 0;
    const usageLabel = s.usage_label || s.usage || '';
    const defText    = s.chinese_def || s.def || '';
    const tags = [];
    if (s.countability) tags.push(`<span class="tag tag-count">${esc(s.countability)}</span>`);
    if (usageLabel)     tags.push(`<span class="tag tag-usage">${esc(usageLabel)}</span>`);
    if (s.antonym)      tags.push(`<span class="tag tag-anto">反 ${esc(s.antonym)}</span>`);
    // 义项频次：高频=实心深色序号 + "常考"标；低频=浅色
    const freq = Number(s.sense_freq || 0);
    const noCls = freq === 1 ? 'no no-high' : (freq === 2 ? 'no no-low' : 'no');
    const freqTag = freq === 1 ? '<span class="tag tag-freq">常考</span>' : '';
    const no = senseNo ? `<span class="${noCls}">${senseNo}</span>` : '';

    // 演示数据的 items 可能是嵌套结构（短语下挂 children 例句），先摊平
    const flatItems = [];
    const flatten = (arr, parent = '') => (arr || []).forEach(it => {
      flatItems.push(Object.assign({}, it, { _parent: parent }));
      if (it.children && it.children.length) flatten(it.children, it.en || parent);
    });
    flatten(s.examples || s.items || []);

    const items = flatItems.map(it => {
      const kind = it.kind === 'phrase'
        ? '<span class="kind">短语</span>' : '<span class="kind">例句</span>';
      const src = it.source ? `<span class="src">${esc(it.source)}</span>` : '';
      const gloss = it.gloss ? `<span class="gloss">${esc(it.gloss)}</span>` : '';
      const parent = (it.parent_phrase || it._parent || '')
        ? `<span class="gloss">↳ ${esc(it.parent_phrase || it._parent)}</span>` : '';
      return `<div class="item src-wrap">${kind}<span class="en">${esc(it.en || '')}</span><span class="zh">${esc(it.zh || '')}</span>${parent}${gloss}${src}</div>`;
    }).join('');

    const engDef = s.english_def ? `<div class="eng-def">${esc(s.english_def)}</div>` : '';
    return `<div class="sense"><div class="sense-hd">${no}
      <span class="pos">${esc(s.pos || '')}</span>
      <span class="def">${esc(defText)}</span>${freqTag}${tags.join('')}</div>
      ${engDef}${items}</div>`;
  }).join('');

  const level = w.level_tag ? `<span class="level">${esc(w.level_tag)}</span>` : '';
  const page = w.page_no ? `<span style="font-size:11px;color:var(--muted)">P${w.page_no}</span>` : '';
  const partialTag = w.partial ? '<span class="partial-tag" title="页尾被截断，扫描下一页会自动补全">待补全</span>' : '';
  // 身份符号徽标
  const IDENTITY = { '*':'课标外', '⊕':'增补', '⊖':'删减', 'derived':'派生词' };
  let identityTag = '';
  if (w.identity_tag && IDENTITY[w.identity_tag]) {
    identityTag = `<span class="tag tag-identity id-${esc(w.identity_tag)}" title="${IDENTITY[w.identity_tag]}">${esc(w.identity_tag)}</span>`;
  }
  // 派生词来源
  const derivedTag = w.derived_from
    ? `<span class="tag tag-derived" title="派生自 ${esc(w.derived_from)}">派生自 ${esc(w.derived_from)}</span>` : '';
  // 蓝底标签框（辨/注/同/句型）
  const notesHtml = (w.notes || []).map(n => {
    const t = ['辨','注','同','句型'].includes(n.note_type) ? n.note_type : '注';
    const title = n.title ? `<div class="note-title">${esc(n.title)}</div>` : '';
    const content = (n.content || '').split(/\n+/).filter(Boolean)
      .map(line => `<div class="note-line">${esc(line).replace(/^•\s*/, '• ')}</div>`).join('');
    return `<div class="vw-note note-${esc(t)}"><span class="note-badge">${esc(t)}</span>${title}<div class="note-body">${content}</div></div>`;
  }).join('');
  const key = w.id != null ? ('id' + w.id) : ('hw' + esc(w.headword));
  // 学习标签徽标：预置三档用各自颜色，自定义用紫色
  const PRESET = ['不会','不熟','已掌握'];
  const studyTags = (w.tags || []).map(t => {
    const cls = PRESET.includes(t) ? t : 'custom';
    return `<span class="study-tag ${cls}">${esc(t)}</span>`;
  }).join('');
  return `<div class="word-card" id="wc-${key}" data-derived="${w.derived_from ? '1' : '0'}"
      oncontextmenu="event.preventDefault();openEditor('${key}')"
      ontouchstart="startLongPress('${key}',event)" ontouchend="cancelLongPress()" ontouchmove="cancelLongPress()"
      onmousedown="startLongPress('${key}',event)" onmouseup="cancelLongPress()" onmouseleave="cancelLongPress()">
    <div class="word-hd" onclick="toggleCard('${key}')">
      <svg class="arrow" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      <span class="word-name">${esc(w.headword)}</span>
      <span class="word-ph">${esc(w.phonetic || '')}</span>
      ${studyTags}${identityTag}${derivedTag}${level}${page}${partialTag}
      <span class="word-def">${esc(w.inline_def || (w.senses && w.senses[0] && (w.senses[0].chinese_def || w.senses[0].def)) || '')}</span>
    </div>
    <div class="word-body">
      ${senses || '<div style="font-size:13px;color:var(--muted);padding:8px 0">（无详细义项）</div>'}
      ${notesHtml}
    </div>
  </div>`;
}
function toggleCard(key) {
  const el = document.getElementById('wc-' + key);
  if (el) el.classList.toggle('open');
}

/* ---------------- 长按检测 ---------------- */
let _pressTimer = null;
function startLongPress(key, ev) {
  cancelLongPress();
  _pressTimer = setTimeout(() => {
    _pressTimer = null;
    if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) {} }
    openEditor(key);
  }, 550);
}
function cancelLongPress() {
  if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; }
}

/* ---------------- 词条 key → word 对象 ---------------- */
function findWordByKey(key) {
  if (key.startsWith('id')) return allWords.find(w => String(w.id) === key.slice(2));
  return allWords.find(w => ('hw' + esc(w.headword)) === key);
}

/* ---------------- 长按编辑：内容 + 学习标签 ---------------- */
const TAG_PRESET = ['不会', '不熟', '已掌握'];
let _editingKey = null;
let _editingTags = [];

// 自定义标签池（跨词复用，存本地）
function loadCustomTags() {
  try { return JSON.parse(localStorage.getItem('vocab_custom_tags') || '[]'); } catch (e) { return []; }
}
function saveCustomTags(arr) {
  localStorage.setItem('vocab_custom_tags', JSON.stringify(Array.from(new Set(arr))));
}

function openEditor(key) {
  cancelLongPress();
  // 已打开则忽略（避免长按同时触发 contextmenu + touchstart 重复打开）
  if (document.getElementById('editorModal').classList.contains('show')) return;
  const w = findWordByKey(key);
  if (!w) return;
  _editingKey = key;
  _editingTags = Array.isArray(w.tags) ? w.tags.slice() : [];
  document.getElementById('edTitle').textContent = w.headword || '编辑词条';
  document.getElementById('edMeta').textContent =
    (w.phonetic || '') + (w.page_no ? ' · P' + w.page_no : '');
  // 可编辑字段：音标、核心释义（inline_def）+ 每个义项的中文释义
  let body = '';
  body += `<div class="ed-field"><label>音标</label><input id="edPhonetic" value="${esc(w.phonetic || '')}"></div>`;
  body += `<div class="ed-field"><label>核心释义（词头右侧）</label><input id="edInlineDef" value="${esc(w.inline_def || '')}" placeholder="如：绷带"></div>`;
  (w.senses || []).forEach((s, idx) => {
    const def = s.chinese_def || s.def || '';
    const pos = s.pos || '';
    const no = s.sense_no ?? s.no ?? (idx + 1);
    body += `<div class="ed-sense-box">
      <div class="ed-sense-hd">${no}. ${esc(pos)}</div>
      <div class="ed-field" style="margin:2px 0 0"><label>中文释义</label>
        <input data-sense-idx="${idx}" class="edSenseDef" value="${esc(def)}"></div>
    </div>`;
  });
  document.getElementById('edBody').innerHTML = body;
  renderEditorTags();
  document.getElementById('editorModal').classList.add('show');
}

function closeEditor() {
  document.getElementById('editorModal').classList.remove('show');
  _editingKey = null;
}

// 编辑弹框里的标签选项（预置 + 自定义标签池 + 当前词已有的）
function renderEditorTags() {
  const pool = Array.from(new Set([...TAG_PRESET, ...loadCustomTags(), ..._editingTags]));
  document.getElementById('edTagChips').innerHTML = pool.map(t => {
    const sel = _editingTags.includes(t);
    const cls = TAG_PRESET.includes(t) ? '' : 'custom';
    const color = TAG_PRESET.includes(t) ? (t==='不会'?'#dc2626':t==='不熟'?'#ea580c':'#16a34a') : '#7c3aed';
    return `<button class="tag-opt ${sel ? 'sel' : ''} ${cls}" data-tag="${esc(t)}" onclick="toggleEditorTag('${esc(t)}')">
      <span class="dot" style="background:${sel ? '#fff' : color}"></span>${esc(t)}</button>`;
  }).join('');
}
function toggleEditorTag(t) {
  const i = _editingTags.indexOf(t);
  if (i >= 0) _editingTags.splice(i, 1);
  else _editingTags.push(t);
  renderEditorTags();
}
function addCustomTag() {
  const inp = document.getElementById('edCustomTag');
  const t = (inp.value || '').trim();
  if (!t) return;
  if (!_editingTags.includes(t)) _editingTags.push(t);
  const pool = loadCustomTags();
  if (!pool.includes(t) && !TAG_PRESET.includes(t)) { pool.push(t); saveCustomTags(pool); }
  inp.value = '';
  renderEditorTags();
}

// 保存编辑：更新内存中的 allWords，并写回数据库/localStorage
async function saveEditor(btn) {
  if (!_editingKey) return;
  const w = findWordByKey(_editingKey);
  if (!w) { closeEditor(); return; }
  const phonetic = document.getElementById('edPhonetic').value.trim();
  const inlineDef = document.getElementById('edInlineDef').value.trim();
  const senseDefs = Array.from(document.querySelectorAll('.edSenseDef'));
  // 更新内存
  w.phonetic = phonetic;
  w.inline_def = inlineDef;
  w.tags = _editingTags.slice();
  senseDefs.forEach(inp => {
    const idx = Number(inp.getAttribute('data-sense-idx'));
    const s = (w.senses || [])[idx];
    if (!s) return;
    if (s.chinese_def !== undefined) s.chinese_def = inp.value.trim();
    else s.def = inp.value.trim();
  });
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    if (!cfg.demo && w.id != null) {
      await patchWord(w, senseDefs);
    } else {
      // 演示模式：写回 localStorage
      let stored = [];
      try { stored = JSON.parse(localStorage.getItem(LS.demo) || '[]'); } catch (e) {}
      const idx = stored.findIndex(x => x.headword === w.headword);
      if (idx >= 0) stored[idx] = w; else stored.push(w);
      localStorage.setItem(LS.demo, JSON.stringify(stored));
    }
    closeEditor();
    toast('已保存');
    rebuildTagFilter();
    resetWordList();
  } catch (e) {
    toast('保存失败：' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

// 在线写回：vw_words(音标/核心释义/tags) + 逐条 vw_senses(中文释义)
async function patchWord(w, senseDefs) {
  const headers = { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
  const wordPayload = { phonetic: w.phonetic || null, inline_def: w.inline_def || null, tags: w.tags };
  const r1 = await fetchWithRetry(`${cfg.url}/rest/v1/vw_words?id=eq.${w.id}`, {
    method: 'PATCH', headers, body: JSON.stringify(wordPayload),
  }, { timeout: 15000, retries: 1, label: '保存词条' });
  if (!r1.ok) throw new Error('词条保存失败 ' + r1.status + ' ' + (await r1.text()).slice(0, 80));
  // 义项中文释义（仅当有 id 的在线义项）
  for (const inp of senseDefs) {
    const idx = Number(inp.getAttribute('data-sense-idx'));
    const s = (w.senses || [])[idx];
    if (!s || s.id == null) continue;
    const val = s.chinese_def !== undefined ? s.chinese_def : s.def;
    const r2 = await fetchWithRetry(`${cfg.url}/rest/v1/vw_senses?id=eq.${s.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ chinese_def: val || null }),
    }, { timeout: 15000, retries: 1, label: '保存义项' });
    if (!r2.ok) throw new Error('义项保存失败 ' + r2.status);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
}

/* ---------------- 初始化 ---------------- */
(function init() {
  // 回填设置表单
  document.getElementById('cfgUrl').value  = cfg.url;
  document.getElementById('cfgKey').value  = cfg.key;
  document.getElementById('cfgBook').value = cfg.book;
  document.getElementById('demoSwitch').classList.toggle('on', cfg.demo);
  applyMode();
  renderVersion();
  refreshWords();
  // 预取扫描进度（弹框弹出时可直接用），失败不影响
  updateProgressDisplay();
})();
