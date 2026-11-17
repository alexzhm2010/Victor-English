// ============================================================
// Supabase Edge Function: scan-page  （页码主导版）
// 职责：一张词典页图片 → 多模态 AI 结构化拆解 → 按页码合并式入库
// 去重主键：(book_id, headword, page_no) —— 同一词在不同页各一条，重扫同页合并
// 跨页补全：页尾半截词标 partial=true；下一页带上 prevContext 时，
//           匹配到上一页 partial 词则合并义项/例句并置 partial=false
// 密钥只在服务端使用，绝不下发前端
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `你是英语词典单页结构化解析引擎。识别图中所有词条，只输出严格 JSON（无多余文字、无 markdown 代码块）。

【版式读取 · 重要】
- 每页分左右两列：先读左列从上到下，再读右列从上到下，按此顺序输出 words。同页单词按字母序。
- 页眉角落的词是"本页导航词"，不是页首词，不要填进 header_word 当作页首词。
- page_no = 图片角落印刷页码（阿拉伯数字），一图一页，务必准确。
- 【铁律：每个单词都是 words 下的平级元素】本页识别到几个词头，words 数组就必须有几个平级 word 对象。
  严禁把一个单词塞进另一个单词的 senses/notes/items 里！每个 word 对象只含它自己的 senses，
  senses 元素里绝不能再出现 headword 字段。例：accomplish/according to/account/accountant/...
  必须各自是 words[0]/words[1]/words[2]/...，绝不是 words[1].senses[2]。嵌套会导致漏词。

【词头行 → word 字段】
词头行可能以这些"身份符号"开头（务必辨认，圆内细节关键）：
- 无任何符号 = 普通课标词 → 省略 identity_tag
- "*" 星号 = 课标外词 → identity_tag="*"
- ⊕ 黑色实心圆内白色十字（加号）= 2017课标增补词 → identity_tag="⊕"
- ⊖ 黑色实心圆内白色一横（减号）= 2017课标删减词 → identity_tag="⊖"
- 词头带灰底 = 课标词的派生/合成词 → identity_tag="derived"
  注意：⊕ 和 ⊖ 都是黑色实心圆，区别只在圆内是十字(+)还是一横(−)，切勿混淆；也不要把实心圆一律当 ⊖。

- 【音标=照描印刷符号，严禁按读音"纠正"】/…/ 里的音标要当成图片上的图形逐符号描下来，不是让你拼写这个词的读音！
  这是最容易错的地方：模型常凭英语知识把印刷音标替换成自己认为的标准读音，必须克制。
  血泪反例（务必记牢）：书上 a 印的是 "/eɪ; et/"，绝对不能输出成 "/ə/"、"/ə; eɪ/" 或 "/eɪ/ 之外的任何形式；
  an 印的是 "/ən; æn/"，照抄即可。分号 "; "、每个音素符号、上标都要与原图一致。
  判断方法：把你输出的 phonetic 和图片逐个符号比对，只要有一个符号不同就是错的，改回图片原样。多个音标并列时全部保留。
- 【同一释义区的多个词头 → 各自独立成词】如 "a /eɪ;et/ an /ən;æn/ art" 是 a 和 an 两个词头共用一个义项区：
  必须输出两个 word 对象——{headword:"a", phonetic:"/eɪ;et/", ...} 和 {headword:"an", phonetic:"/ən;æn/", ...}，
  两者复用同一套 senses/items（各复制一份完整义项/例句）。绝不能只输出第一个词头或把两个词头合并成一个字符串。
- 【词频标记一律忽略】音标后即使印有"柱状图 + R上标数字"，也【绝不输出 freq_level 字段】——该功能已取消，无需识别。忽略即可，不要脑补任何数字。
- 词条行紧跟的中文核心释义（词头行末尾、义项之前的短释义）存入 level_tag。
- 词头行里方括号【用法说明】（如「[a一般用于辅音音素开始的词前，an一般用于元音音素开始的词前]」）存入 inline_def，原样保留文字。这不是义项、不是例句，不要丢弃也不要塞进 senses。

【▶/▼ 派生词 → 独立 word】
- 词头行以 ▶ 或 ▼（实心三角）开头的词，如「▶ assuming (that) conj」「▶ attached adj」，是主词的直接派生词：输出为独立 word 对象，derived_from=它所属主词的词头（assuming→assume, attached→attach）。它有自己完整的音标/词性/义项/例句，照常解析，不要并进主词、也不要当例句丢弃。
- 判别：▶/▼ 后若跟一个"新单词词头"（新词+音标/词性）才是派生词；若只是「▼ vi 呼吁」接在名词义项后、后面无新词头，则只是下一个 sense 的词性分节，不派生新词。

【义项 → sense 字段】
- "■ <词性>" 是词性分节符：一词多词性(n./vi./vt./adj./conj./prep./pron.)时，每个 ■ 段落开启一个新的 pos 分组。
- 大号实心黑圆 ①②③ = 义项编号 → sense_no（1/2/3，无则0）。深色序号=高频义 sense_freq=1；浅色序号=低频义 sense_freq=2；看不出则省略。
- 【一词多词性必须按词性归组、组内按编号顺序输出（硬规则）】同一单词若有多个词性、且每个词性下有多个义项时，senses 数组必须严格按书上版式排列：先按词性分节顺序（书上先出现的词性在前，如 across 先 prep. 后 adv.），把同一词性的所有义项连续排在一起；每个词性组内部再按义项编号 ①②③ 升序排列。严禁把不同词性的义项交错混排（如 prep①→prep③→adv②→prep②→adv① 是错的，正确为 prep①→prep②→prep③→adv①→adv②）。例句随其所属义项一起输出，不要因排序与例句错位。
- 小号空心圆 ①② 或加粗斜体短语 = 义项内固定搭配 → item.kind="phrase"。
- 斜体英文释义（如 to make a serious request for sth）→ sense.english_def。
- 【用法标签】→ usage_label；[C]/[U]/[C]&[U] → countability；「反 X」标签或 原词: → antonym。

【并列短语动词 → 每个独立成 phrase，例句必须归到各自短语（血泪规则）】
词典常在一个义项区里连续列出多个【加粗短语动词】，每个形如「加粗英文短语 ＋ 中文释义」，其下再跟自己的例句，例如 act 词条：
  act as 充当；起……作用 → 例句 A trained dog can act as a guide to a blind person.
  act on 按照……行事（= act upon）→ 例句 Why didn't you act on her suggestion? / Alcohol acts quickly on the brain.
  act out 把……表演出来；将……付诸行动 → 例句 I always read... acting out the stories... / act out a theory
处理铁律：
- 每一个加粗短语动词必须单独输出为一个 item：kind="phrase"，en=英文短语本身，zh=它后面紧跟的中文释义（如 "act as" / "充当；起……作用"）。几个短语就是几个平级 phrase item，绝不能合并。
- 【严禁把短语的中文释义塞进 sense.chinese_def】上面 act 的正确结果是 sense.chinese_def 保持义项本身的释义（如"演（戏）；扮演（角色）"或一个空义项），而 "把……表演出来" 这类必须放在对应 phrase item 的 zh 里。把 "act out 把……表演出来" 写成 sense.chinese_def 是错的。
- 【严禁把多个短语的例句全堆到最后一个短语或某个义项下】每个例句必须作为 children 挂到它真正所属的那个 phrase item 下：怎么判断归属？看例句紧跟在哪个加粗短语后面、或例句里出现了哪个短语动词（act as 的例句含 "act as"，act on 的例句含 "act on/acts on"，act out 的例句含 "act out/acting out"），就挂到那个 phrase 的 children。
- 短语释义后括号里的同义提示如（= act upon）→ 存入该 phrase item 的 gloss，不要新建 phrase，也不要丢。
- 判别例外：句子里出现 "act as if..."（= 表现得好像）这类【并非词条列出的加粗短语动词】时，它是所在的那个义项（如"举止；表现"）的普通例句，kind="sentence"，不要误当成 "act as" 搭配的例句。只把真正加粗列出的短语动词当 phrase。

【例句 → example 字段】
- kind="sentence"；斜体英文 en + 中文 zh；句末出处（人教③-5 / 2013全国 / 译林新选必①-2）照常存入 source。
- 搭配下的例句放进该 phrase item 的 children。
- 斜体同义注释如 (= die suddenly) → gloss。
- 句型小标题（加粗，如 provide sth for sb）→ item.kind="phrase"，作为该义项下的搭配条。

【蓝底标签框 → notes（重要）】
图中蓝底小方块标签开头的方框，不是词条也不是例句，输出到【紧挨着它的那个词条】的 notes 数组：
- "辨 X, Y"（如 辨 assist, help, aid / 辨 as, which）= 近义词辨析 → note_type="辨", title=主题, content=框内文字。
- "注"（如 ache常与表示身体部位的单词构成合成词）= 小贴士 → note_type="注"。
- "同"（如 同 whiskers, moustache）= 词族/近义词 → note_type="同"。
- "反"（如 反 ...）= 反义词 → note_type="反"。
- "句型" / "常用词块" / "用法点拨" 等其他蓝底标签框 → note_type 用标签上的原文（如 "句型"、"常用词块"）。
content 保留框内文字与项目符号。不要把这些框里的句子塞进任何单词的例句。

【高考链接 → notes（必须展示，不要跳过）】
蓝底"高考链接①②③…"方块（如 ache 下 "高考链接 ① It offers a place where you can sit down to rest your ___ (ache) legs. (2021 新高考)"、achievement 下 "高考链接 ① ... a real sense of ___ (achieve). (2016 全国)"）是书本特色栏目，必须解析并输出到【紧挨着它的那个词条】的 notes 数组：
- note_type="高考链接"，title 填编号（如 "①" 或 "1"），content 保留框内完整文字（题干、_____填空、括号里的提示词、出处如 "(2021 新高考)"、"答案"行等）。
- 这是真题填空练习，整块作为一个 note，不要拆成语例句、不要当词条、不要拆成义项。
- 关键：高考链接框出现在哪个词条正下方，就归到哪个词条的 notes（例：ache 框归 ache，achievement 框归 achievement）。
- 注意区分：词条普通例句句末的出处（人教③-5、2013全国、译林新选必①-2）仍照常存入 example.source，那是普通例句，不是高考链接框。

【跨页 · partial（关键：页首页尾残段都不能丢）】
- 页尾词被截断、将在下页继续 → 该词 partial=true，boundary.tail 填该词头。
- 页首无完整词头行、直接出现义项/词性/例句（说明是延续上一页某词的残段）：
  · 若用户消息含 PREV_PAGE_TAIL 且能对应其词头 → 用该词头作 headword，把延续内容作为该词的 sense 放进 words，正常合并。
  · 否则（没有 PREV_PAGE_TAIL，或词头对不上）→ 必须把这段页首残段单独输出为一个 word 对象，并额外带三个字段：fragment_side:"head"、partial:true、headword 填你能从例句/释义推断的词头（实在推不出填 "?"），senses 正常填这段残段的义项与例句。系统会把这段残段存入"握手池"，等上一页录入后自动合并——绝不要丢弃，也不要当成完整独立词条。
- 一页最多只有一个页首残段（页面最顶部那一小段），不要在多处乱标 fragment_side。

【输出精简】字段无值直接省略该键，不要输出空串/空数组/false 占位。无法辨认的字符不要编造，保留原文或留空，务必保留音标与中文。fragment_side 只用于页首残段，普通词条不要输出。只输出严格 JSON。

【铁律：先点名清单 checkList，再建树——保证不漏】
本页识别时，先在顶层输出 checkList：把你在图上看到的【每一个独立词头】按版式顺序各列出一次（纯字符串，含普通词、*星号词、⊕/⊖、▶▼派生词、页尾半截词、共用释义区的多词头如 a 和 an 都要各算一个）。
然后 words 里必须为 checkList 的每个词头建立一个平级 word 对象；每个 word 的 headword 必须且只能对应 checkList 里的一条。
铁律：checkList 的数量 == words 的数量，一个都不能少、不能多。凡是图上出现的词头，必须先进入 checkList，再落到 words——不允许"看了没列、列了没落"。
后端会逐条对账：checkList 里有、words 里没有的，视为孤儿词单独召回补建。所以 checkList 务必穷尽本页词头，不漏列。
但【严禁按字母顺序脑补】：checkList 里每一个词头都必须是本页图片上真实印刷出来、你能用手指到的；绝不能因为字母顺序（如上一页是 abuse、本页从 academic 开始）就把相邻页的词也列进来。多列一个图上没有的词 = 错误，和漏列一样严重。

输出结构（有值才输出）：
{"page_no":27,"header_word":"appeal","checkList":["apart","act"],
"words":[
 {"headword":"apart","partial":false,"phonetic":"/əˈpɑːt/","identity_tag":null,"derived_from":null,"level_tag":"相隔的",
  "senses":[{"pos":"adv.","sense_no":1,"sense_freq":1,"countability":"","usage_label":"","chinese_def":"相隔地","english_def":"",
   "items":[{"kind":"phrase","en":"apart from","zh":"除……外","gloss":"","source":"","children":[{"kind":"sentence","en":"...","zh":"...","source":"人教③-5"}]},
            {"kind":"sentence","en":"...","zh":"...","source":"2013全国"}]}],
  "notes":[{"note_type":"辨","title":"apart from, besides","content":"..."}]},
 {"headword":"act","phonetic":"/ækt/","senses":[
  {"pos":"v.","sense_no":4,"chinese_def":"演（戏）；扮演（角色）","items":[
    {"kind":"sentence","en":"He had always wanted to act in films...","zh":"...","source":"译林③-2"}]},
  {"pos":"phr.","chinese_def":"","items":[
    {"kind":"phrase","en":"act as","zh":"充当；起……作用","children":[{"kind":"sentence","en":"A trained dog can act as a guide...","zh":"..."}]},
    {"kind":"phrase","en":"act on","zh":"按照……行事","gloss":"= act upon","children":[{"kind":"sentence","en":"Why didn't you act on her suggestion?","zh":"..."},{"kind":"sentence","en":"Alcohol acts quickly on the brain.","zh":"..."}]},
    {"kind":"phrase","en":"act out","zh":"把……表演出来；将……付诸行动","children":[{"kind":"sentence","en":"...acting out the stories...","zh":"..."}]}]}]}]
],"boundary":{"head":null,"tail":null}}`;

type Item = {
  kind?: string; en?: string; zh?: string; usage_label?: string;
  gloss?: string; source?: string; children?: Item[]; parent_phrase?: string;
};
type Sense = {
  pos?: string; sense_no?: number; sense_freq?: number; countability?: string; usage_label?: string;
  chinese_def?: string; english_def?: string; antonym?: string; items?: Item[];
};
type Note = { note_type?: string; title?: string; content?: string };
type Word = {
  headword: string; partial?: boolean; phonetic?: string; audio?: boolean;
  identity_tag?: string | null; freq_level?: number | null; derived_from?: string | null;
  level_tag?: string; inline_def?: string; countability?: string;
  source?: string; senses?: Sense[]; notes?: Note[];
  fragment_side?: string;   // 'head' = 页首残段，延续上一页某词（先入握手池，不单独建正式词条）
};
type Boundary = { head?: { word?: string; note?: string } | null; tail?: { word?: string; note?: string } | null };

// 词头归一化：用于 checkList 与 words 对账（忽略大小写/空格/句点/身份符号）
function normHead(s: string): string {
  return String(s || "").toLowerCase()
    .replace(/^[*⊕⊖▶▼\s]+/, "")   // 去掉身份/派生前导符号
    .replace(/[\s.·?'’]/g, "");
}

// 清单对账：checkList（图上点名的词） vs words（实际落树的词）
// 返回 orphanHeads = 在清单里但没落进树的词头（本该有却丢了），需要补建。
function reconcileChecklist(checkList: string[], words: Word[]): {
  checkCount: number; wordCount: number; orphanHeads: string[];
} {
  const cls = (checkList || []).map(normHead).filter(Boolean);
  const whs = new Set((words || []).map(w => normHead(w.headword)).filter(Boolean));
  const orphanHeads = (checkList || []).filter((c, i) => cls[i] && !whs.has(cls[i]));
  return { checkCount: cls.length, wordCount: whs.size, orphanHeads };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// 判断一条例句是否来自"高考链接"方块里的高考真题（应跳过，不入库）。
// 依据：出处含全国卷/新高考/改错等试卷标记，或题干含连续下划线填空且带题号/试卷出处。
// 刻意不把普通省份/教材出处（人教③-5、2011陕西、译林新选必①-2）判为高考题，避免误伤。
function isGaokaoLinkItem(it: Item): boolean {
  const src = it.source || "";
  const en = it.en || "";
  const examSource = /全国\s*[ⅠⅡⅢIV1-3]?\s*卷|新高考|全国卷|\(改错\)|（改错）|高考真题|高考链接/.test(src);
  const blankWithNo = /[_＿]{4,}/.test(en) && /^\s*\d+\s*[\.、]/.test(en);
  return examSource || blankWithNo;
}

function flattenItems(items: Item[] = [], parent = ""): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    if (isGaokaoLinkItem(it)) continue;   // 高考链接方块的试题：直接丢弃
    // parent_phrase 只用于"挂在某搭配下的子例句"，标明它属于哪个短语。
    // 顶层例句/搭配本身就是主体，parent 为空时绝不能把 en 自己塞进 parent_phrase，
    // 否则前端会用 ↳ 把英文原文再显示一遍（看起来像重复）。
    out.push({ ...it, parent_phrase: parent || "" });
    if (it.children?.length) out.push(...flattenItems(it.children, it.en || parent));
  }
  return out;
}

// 打平"被错误嵌套进 senses/notes 里的词条"。
// 豆包偶尔会把本该平级的多个词条塞进前一个词的 senses 数组里（每个都有 headword+senses），
// 若只取顶层 words 就会漏掉这些词。这里递归扫描整个结构，把符合条件的词条提取到顶层，
// 并从它所在的位置移除，避免它被当成某个词的义项处理。
// 词条判定：有非空字符串 headword 且带 senses 数组；普通 sense 没有 headword，不会误伤。
function looksLikeWord(o: any): boolean {
  return !!o && typeof o === "object"
    && typeof o.headword === "string" && o.headword.trim().length > 0
    && Array.isArray(o.senses);
}
function extractNestedWords(root: any): any[] {
  const found: any[] = [];
  const visit = (node: any) => {
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const child = node[i];
        if (looksLikeWord(child)) {
          found.push(child);
          visit(child);        // 提取后仍递归其内部，找更深一层的嵌套词条
          node.splice(i, 1);   // 从父数组移除，避免它被当义项/例句处理
        } else {
          visit(child);
        }
      }
    } else if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        // 只递归可能含嵌套词条的结构字段，避免无谓遍历
        if (["senses", "notes", "items", "children", "words"].includes(k)) visit(node[k]);
      }
    }
  };
  visit(root);
  return found;
}
// 合并顶层 words 与打平出来的词条，按 headword 去重（保留 senses 更完整的那份）
function dedupeWords(words: any[]): any[] {
  const map = new Map<string, any>();
  for (const w of words) {
    if (!w || typeof w.headword !== "string" || !w.headword.trim()) continue;
    const key = w.headword.trim();
    const prev = map.get(key);
    if (!prev || (w.senses?.length || 0) > (prev.senses?.length || 0)) map.set(key, w);
  }
  return Array.from(map.values());
}

function normEn(s: string): string {
  return (s || "").toLowerCase().replace(/[\s\p{P}]/gu, "");
}
// 词性归一化：去掉末尾句点（adj./adj. → adj；adv. → adv），
// 避免同一次重扫因带点/不带点写出两条重复义项
function normPos(p: string | undefined): string {
  return String(p || "").trim().replace(/\.+$/, "").toLowerCase();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  let batchId: number | null = null;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  try {
    const body = await req.json();
    const {
      imageUrl, bookId = "victor", pageNo,
      batchId: incomingBatch,
      force = false,        // 强制重扫：先清空该页旧词条（含义项/例句/笔记）再重新入库
      prevContext = null,   // { page_no: N, partial_words: [{headword, phonetic, senses:[...]}] }
    } = body;
    if (!imageUrl) return json({ ok: false, error: "缺少 imageUrl" }, 400);

    batchId = incomingBatch ?? null;

    const aiBase  = Deno.env.get("AI_BASE_URL") || "https://ark.cn-beijing.volces.com/api/v3";
    const aiModel = Deno.env.get("AI_MODEL") || "doubao-seed-2-1-lite-260915";
    const apiKey  = Deno.env.get("ARK_API_KEY")
                 || Deno.env.get("OPENAI_API_KEY")
                 || Deno.env.get("VOLC_API_KEY");
    if (!apiKey) return json({ ok: false, error: "服务端未配置 ARK_API_KEY（或 OPENAI_API_KEY）" }, 500);

    // ---- 握手池：录入前主动取"上一页留在池里、等本页承接的 tail 残段" ----
    // 解决场景A：无论上一页是很久前录的、失败重试补录的、还是中间隔了很多页，
    // 本页都能从池里拿到半截词上下文，而不只依赖前端内存里那条易断的 nextContext。
    let poolTailRows: any[] = [];
    if ((pageNo || 0) > 0) {
      const { data: tRows } = await supabase.from("vw_page_handshakes")
        .select("page_no,headword,payload")
        .eq("book_id", bookId).eq("side", "tail")
        .eq("neighbor_page_no", pageNo).eq("status", "pending");
      poolTailRows = tRows || [];
    }

    // 上一页半截词上下文：合并「前端内存上下文」+「握手池上下文」，按 headword 去重
    const prevPartialWords: any[] = [];
    const seenPrev = new Set<string>();
    for (const p of [
      ...(Array.isArray(prevContext?.partial_words) ? prevContext.partial_words : []),
      ...poolTailRows.map(r => ({ headword: r.headword, senses: r.payload })),
    ]) {
      const hw = String(p?.headword || "").trim();
      if (!hw || seenPrev.has(hw)) continue;
      seenPrev.add(hw);
      prevPartialWords.push(p);
    }
    const prevPageNo = prevContext?.page_no ?? (poolTailRows[0]?.page_no ?? null);

    let userText = "请解析这张词典页面图片，按系统提示的 JSON 结构输出。";
    if (prevPageNo !== null || prevPartialWords.length) {
      userText += "\n\nPREV_PAGE_TAIL（上一页的页码与页尾半截词，供你判断页首承接、补全半截词）：\n"
        + JSON.stringify({ page_no: prevPageNo, partial_words: prevPartialWords });
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
        ],
      },
    ];

    const requestAI = async (withJsonMode: boolean, msgs = messages) =>
      fetch(`${aiBase}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: aiModel,
          temperature: 0,
          ...(aiBase.includes("ark.cn") ? { thinking: { type: "disabled" } } : {}),
          ...(withJsonMode ? { response_format: { type: "json_object" } } : {}),
          messages: msgs,
        }),
      });

    // 单次解析：请求 → 清洗 → 打平 → 去重，返回干净词表
    const parseOnce = async (msgs = messages): Promise<any> => {
      let aiResp = await requestAI(true, msgs);
      if (!aiResp.ok) {
        const t = await aiResp.text();
        const unsupported = /response_format|json_object|json mode|unsupported|not support|参数|不支持/i.test(t);
        if (unsupported) aiResp = await requestAI(false, msgs);
        else throw new Error(`AI 请求失败 ${aiResp.status}: ${t.slice(0, 300)}`);
      }
      if (!aiResp.ok) {
        const t = await aiResp.text();
        throw new Error(`AI 请求失败 ${aiResp.status}: ${t.slice(0, 300)}`);
      }
      const aiJson = await aiResp.json();
      let content: string = aiJson.choices?.[0]?.message?.content || "";
      content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const p = JSON.parse(content);
      // 防御性打平：AI 偶尔把多个词条嵌套进前一个词的 senses 里，全部提取到顶层并去重。
      const flatWords = extractNestedWords(p);
      const words: Word[] = dedupeWords(flatWords);
      p.words = words;
      return p;
    };

    // 先查旧词数（force 重扫时作为"识别是否完整"的参照）
    let oldWordCount = 0;
    if (force && pageNo > 0) {
      const { count } = await supabase.from("vw_words")
        .select("id", { count: "exact", head: true })
        .eq("book_id", bookId).eq("page_no", pageNo);
      oldWordCount = count || 0;
    }

    // 【省流核心 v2.12】单次主解析，不再固定双采样。
    // 漏词的根因不是"视觉没看到"，而是"看了没归位"。所以改为：
    //   1) 一次解析，让豆包先点名 checkList（图上所有词头）再建树；
    //   2) 后端对账 checkList vs words，找出"点了名却没落树"的孤儿词；
    //   3) 仅当有孤儿时，才补一次【定向归位】——只让 AI 输出这几个词的完整子树，
    //      而不是整页重扫。绝大多数页一次调用即可，显著省流且不再靠反复碰运气。
    let parsed = await parseOnce();
    let attempts = 1;

    const words: Word[] = parsed.words || [];
    const checkList: string[] = Array.isArray(parsed.checkList)
      ? parsed.checkList.map((x: any) => String(x).trim()).filter(Boolean)
      : [];

    // 清单对账：checkList 里有、words 里没有的 = 应归位却丢失的孤儿词
    const recon = reconcileChecklist(checkList, words);
    const orphanHeads = recon.orphanHeads;
    const recoveredHeads: string[] = [];
    let orphansRecovered = 0;

    if (orphanHeads.length > 0) {
      const orphanPrompt = `上一轮你已经在本页 checkList 里点名了下面这些词头，但在 words 里漏掉了它们，导致它们"没地方安放"：
${orphanHeads.map(h => `- ${h}`).join("\n")}
请只输出这几个被漏掉词的完整 word 对象（严格按系统提示的 JSON 结构，含音标/词性/senses/items/notes，音标逐符号照描印刷原样），把它们补进树里。输出严格 JSON：{"words":[...]}。不要输出其它词，也不要输出 checkList。`;
      const fixMessages = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: orphanPrompt },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          ],
        },
      ];
      try {
        const fix = await parseOnce(fixMessages);
        attempts++;
        const existing = new Set(words.map(w => normHead(w.headword)));
        for (const w of (fix.words || [])) {
          const k = normHead(w.headword);
          if (!k || existing.has(k)) continue;
          words.push(w);
          existing.add(k);
          recoveredHeads.push(w.headword);
          orphansRecovered++;
        }
        console.log(`清单对账：checkList ${recon.checkCount} 词，words ${recon.wordCount} 词，孤儿 ${orphanHeads.length}，定向补回 ${orphansRecovered}`);
      } catch (e) {
        console.warn("孤儿词定向归位失败，沿用主解析结果", e);
      }
    }

    const boundary: Boundary = parsed.boundary || {};
    // 页码来源：detect 阶段已从图片识别并落库，scan 阶段沿用该页码，保证词表与页码表一致。
    // parsed.page_no 是本次 scan 的 AI 复核值，仅作兜底（detect 页码缺失时）。
    const detectedPage = Math.max(0, parseInt(parsed.page_no, 10) || 0);
    const thisPage = (pageNo || 0) || detectedPage;

    let senseCount = 0;
    let exampleCount = 0;
    let mergedSenses = 0;
    let mergedExamples = 0;
    let resumedWords = 0;       // 本页补全的上一页半截词数量
    const partialWordsOut: any[] = [];  // 本页新增/仍半截的词，供下一页补全

    // ---- 强制重扫：AI 已成功解析出结果后，先清空该页旧数据再入库 ----
    // 放在解析成功之后，确保 AI 失败时不会误删旧数据。
    let forceCleared = 0;
    // 【防丢失保护】重扫若识别数明显偏少（<旧的70%），判定为识别不完整，
    // 保留原数据不覆盖，要求重试。宁可不更新，也不能把 10 个词洗成 5 个。
    let forceSkipped = false;
    if (force && thisPage > 0) {
      const { data: oldWords } = await supabase.from("vw_words")
        .select("id").eq("book_id", bookId).eq("page_no", thisPage);
      const oldIds = (oldWords || []).map((w: any) => w.id);
      if (oldIds.length && words.length < oldIds.length * 0.7) {
        forceSkipped = true;
        console.warn(`force 保护触发：旧 ${oldIds.length} 词，本次仅识别 ${words.length} 词，拒绝覆盖`);
        if (batchId) {
          await supabase.from("vw_scan_batches").update({
            status: "error",
            error_msg: `本次仅识别 ${words.length} 个词（原有 ${oldIds.length} 个），疑似识别不完整，已保留原数据，请重试`,
          }).eq("id", batchId);
        }
        return json({
          ok: false,
          error: `本次仅识别 ${words.length} 个词（原有 ${oldIds.length} 个），疑似识别不完整，已保留原数据，请重试`,
          words_found: words.length,
          force_skipped: true,
        }, 422);
      }
      if (!forceSkipped) {
        if (oldIds.length) {
          const { data: oldSenses } = await supabase.from("vw_senses")
            .select("id").in("word_id", oldIds);
          const oldSenseIds = (oldSenses || []).map((s: any) => s.id);
          if (oldSenseIds.length) {
            await supabase.from("vw_examples").delete().in("sense_id", oldSenseIds);
            await supabase.from("vw_senses").delete().in("id", oldSenseIds);
          }
          await supabase.from("vw_notes").delete().in("word_id", oldIds);
          await supabase.from("vw_words").delete().in("id", oldIds);
          forceCleared = oldIds.length;
        }
        // 该页相关握手记录重置为 pending（残段内容将随本次解析重新登记）
        await supabase.from("vw_page_handshakes").delete()
          .eq("book_id", bookId).eq("page_no", thisPage);
        // 邻接页指向本页的 tail 也需重置，避免拿旧残段误合并
        await supabase.from("vw_page_handshakes").update({ status: "pending", updated_at: new Date().toISOString() })
          .eq("book_id", bookId).eq("side", "tail").eq("neighbor_page_no", thisPage);
      }
    }

    // 上一页半截词 headword 集合
    const prevPartialSet = new Set(prevPartialWords.map((p: any) => String(p.headword || "").trim()));

    // 把某词的所有 senses 合并进指定 word_id（义项按 pos|sense_no 合并，例句按文本去重）
    const mergeIntoSenses = async (targetWordId: number, senses: Sense[]) => {
      const { data: existingSenses } = await supabase
        .from("vw_senses").select("id,pos,sense_no,chinese_def").eq("word_id", targetWordId);
      const senseMap = new Map<string, any>();
      for (const es of existingSenses || []) senseMap.set(`${normPos(es.pos)}|${es.sense_no ?? 0}`, es);

      for (const s of senses || []) {
        const key = `${normPos(s.pos)}|${s.sense_no ?? 0}`;
        let senseId: number;
        if (senseMap.has(key)) {
          const existing = senseMap.get(key);
          senseId = existing.id;
          mergedSenses++;
          const mergedDef = (existing.chinese_def && s.chinese_def)
            ? (existing.chinese_def.length >= s.chinese_def.length ? existing.chinese_def : s.chinese_def)
            : (s.chinese_def || existing.chinese_def || null);
          await supabase.from("vw_senses").update({
            chinese_def: mergedDef,
            usage_label: s.usage_label || existing.usage_label || null,
            countability: s.countability || existing.countability || null,
            antonym: s.antonym || existing.antonym || null,
            english_def: s.english_def || existing.english_def || null,
            sense_freq: s.sense_freq ?? existing.sense_freq ?? null,
          }).eq("id", senseId);
        } else {
          const { data: senseRow, error: sErr } = await supabase.from("vw_senses")
            .insert({
              word_id: targetWordId, pos: s.pos || null, sense_no: s.sense_no ?? 0,
              countability: s.countability || null, usage_label: s.usage_label || null,
              chinese_def: s.chinese_def || null, antonym: s.antonym || null,
              english_def: s.english_def || null, sense_freq: s.sense_freq ?? null,
            }).select("id").single();
          if (sErr) throw new Error(`写入义项失败: ${sErr.message}`);
          senseId = senseRow.id;
          senseMap.set(key, { id: senseId, chinese_def: s.chinese_def });
        }
        senseCount++;

        const { data: existingExamples } = await supabase
          .from("vw_examples").select("id,en").eq("sense_id", senseId);
        const seen = new Set((existingExamples || []).map((e: any) => normEn(e.en || "")));
        // 批量写入：先按去重规则过滤出待插入行，再一次 insert，减少数据库往返
        const rowsToInsert: any[] = [];
        for (const it of flattenItems(s.items || [])) {
          if (!it.en && !it.zh) continue;
          const n = normEn(it.en || "");
          if (n && seen.has(n)) { mergedExamples++; continue; }
          if (n) seen.add(n);
          rowsToInsert.push({
            sense_id: senseId, parent_phrase: it.parent_phrase || null,
            kind: it.kind || "sentence", usage_label: it.usage_label || null,
            en: it.en || null, zh: it.zh || null, gloss: it.gloss || null, source: it.source || null,
          });
        }
        if (rowsToInsert.length) {
          const { error: eErr } = await supabase.from("vw_examples").insert(rowsToInsert);
          if (eErr) throw new Error(`写入例句失败: ${eErr.message}`);
          exampleCount += rowsToInsert.length;
        }
      }
    };

    // 写入蓝底标签框（辨/注/同/反/句型/高考链接/常用词块等）到 vw_notes；先清掉该词旧 notes 再插，避免重扫重复
    let noteCount = 0;
    const writeNotes = async (wordId: number, notes: Note[]) => {
      if (!notes?.length) return;
      await supabase.from("vw_notes").delete().eq("word_id", wordId);
      const rows = notes
        .filter(n => n.note_type && (n.title || n.content))
        .map(n => ({
          word_id: wordId,
          note_type: String(n.note_type).slice(0, 20),
          title: n.title || null,
          content: n.content || null,
        }));
      if (rows.length) {
        const { error: nErr } = await supabase.from("vw_notes").insert(rows);
        if (nErr) throw new Error(`写入标签框失败: ${nErr.message}`);
        noteCount += rows.length;
      }
    };

    // ---- 握手池写入（幂等）----
    // 唯一键 (book_id, page_no, side)：同一页同一侧永远只有一条记录。
    // 已 matched 的记录不被覆盖回 pending（除非残段内容确实变了），避免重复握手。
    let handshakesTouched = 0;
    const sensesPayload = (senses: Sense[] = []) => (senses || []).map(s => ({
      sense_no: s.sense_no ?? 0, pos: s.pos || "", chinese_def: s.chinese_def || "",
      items: flattenItems(s.items || []).map(it => ({ en: it.en || "", zh: it.zh || "" })),
    }));
    const upsertHandshake = async (side: "head" | "tail", neighbor: number, headword: string, wordId: number | null, senses: Sense[]) => {
      if (!(thisPage > 0)) return;
      const payload = sensesPayload(senses);
      // 先查同键旧记录：若已 matched 且 payload 未变，则完全不动（幂等核心）
      const { data: old } = await supabase.from("vw_page_handshakes")
        .select("status,payload,headword").eq("book_id", bookId)
        .eq("page_no", thisPage).eq("side", side).maybeSingle();
      if (old?.status === "matched" && JSON.stringify(old.payload) === JSON.stringify(payload)) return;
      await supabase.from("vw_page_handshakes").upsert({
        book_id: bookId, page_no: thisPage, side, neighbor_page_no: neighbor,
        headword: headword || null, word_id: wordId, payload, status: "pending",
        updated_at: new Date().toISOString(),
      }, { onConflict: "book_id,page_no,side" });
      handshakesTouched++;
    };

    // ---- 阶段一：先写入所有"非派生词"，建立 headword -> word_id 映射 ----
    // 派生词(derived_from 非空)留到阶段二，以便回填 parent_word_id。
    const headwordToId = new Map<string, number>();
    const processed: { w: Word; hw: string; wordId: number; isResume: boolean }[] = [];

    // 页首残段（fragment_side='head'）不建正式词条，单独收集后入握手池 head 侧
    const headFragments = words.filter(w => w.fragment_side === "head" && w.headword);
    const normalWords = words.filter(w => w.fragment_side !== "head");

    const upsertWord = async (w: Word, hw: string, isPartial: boolean, parentWordId: number | null) => {
      const { data: wordRow, error: wErr } = await supabase.from("vw_words").upsert(
        {
          book_id: bookId, headword: hw,
          phonetic: w.phonetic || null, audio: !!w.audio,
          identity_tag: w.identity_tag || null,
          freq_level: w.freq_level ?? null,
          derived_from: w.derived_from || null,
          parent_word_id: parentWordId,
          level_tag: w.level_tag || null, inline_def: w.inline_def || null,
          countability: w.countability || null, source: w.source || null,
          page_no: thisPage, batch_id: batchId, partial: isPartial,
        },
        { onConflict: "book_id,headword,page_no", ignoreDuplicates: false }
      ).select("id").single();
      if (wErr) throw new Error(`写入单词 ${hw} 失败: ${wErr.message}`);
      return wordRow.id;
    };

    for (const w of normalWords) {
      if (!w.headword) continue;
      const hw = String(w.headword).trim();
      const isPartial = !!w.partial;
      const isDerived = !!(w.derived_from && String(w.derived_from).trim());

      // 派生词：阶段二处理
      if (isDerived) continue;

      // 判断是否为"上一页半截词的补全"：本页词命中上一页 partial 集合
      if (prevPartialSet.has(hw) && prevPageNo !== null) {
        const { data: prevRows } = await supabase.from("vw_words")
          .select("id,phonetic").eq("book_id", bookId).eq("headword", hw).eq("page_no", prevPageNo);
        if (prevRows && prevRows.length) {
          const targetWordId = prevRows[0].id;
          await mergeIntoSenses(targetWordId, w.senses || []);
          await writeNotes(targetWordId, w.notes || []);
          await supabase.from("vw_words").update({ partial: false })
            .eq("id", targetWordId);
          resumedWords++;
          headwordToId.set(hw, targetWordId);
          // 场景A闭环：上一页 tail 残段已补全，握手池标记 matched 并去掉 partial 词标记
          await supabase.from("vw_page_handshakes").update({ status: "matched", updated_at: new Date().toISOString() })
            .eq("book_id", bookId).eq("side", "tail").eq("page_no", prevPageNo).eq("headword", hw);
          continue;  // 不在本页重复建词条
        }
      }

      const wordId = await upsertWord(w, hw, isPartial, null);
      headwordToId.set(hw, wordId);
      await mergeIntoSenses(wordId, w.senses || []);
      await writeNotes(wordId, w.notes || []);
      processed.push({ w, hw, wordId, isResume: false });
    }

    // ---- 阶段二：处理派生词，按 derived_from 回填 parent_word_id ----
    const findParentId = async (motherWord: string): Promise<number | null> => {
      // 1) 本页映射优先
      if (headwordToId.has(motherWord)) return headwordToId.get(motherWord)!;
      // 2) 查数据库（同书、同词头，取页码最大=最近的一条）
      const { data: rows } = await supabase.from("vw_words")
        .select("id").eq("book_id", bookId).eq("headword", motherWord)
        .order("page_no", { ascending: false }).limit(1);
      return rows?.[0]?.id ?? null;
    };

    for (const w of normalWords) {
      if (!w.headword) continue;
      const hw = String(w.headword).trim();
      const mother = String(w.derived_from || "").trim();
      if (!mother) continue;  // 非派生词已处理
      const isPartial = !!w.partial;
      const parentId = await findParentId(mother);
      const wordId = await upsertWord(w, hw, isPartial, parentId);
      headwordToId.set(hw, wordId);
      await mergeIntoSenses(wordId, w.senses || []);
      await writeNotes(wordId, w.notes || []);
      processed.push({ w, hw, wordId, isResume: false });
    }

    // 收集本页仍为半截的词（供下一页补全）——含派生词，并登记到握手池 tail 侧
    for (const p of processed) {
      if (p.isResume || !p.w.partial) continue;
      partialWordsOut.push({
        headword: p.hw,
        phonetic: p.w.phonetic || null,
        senses: (p.w.senses || []).map(s => ({
          sense_no: s.sense_no ?? 0, pos: s.pos || "", chinese_def: s.chinese_def || "",
          items: flattenItems(s.items || []).map(it => ({ en: it.en || "", zh: it.zh || "" })),
        })),
      });
      // 握手池 tail：本页页尾残词，等下一页（neighbor=本页+1）来承接
      await upsertHandshake("tail", thisPage + 1, p.hw, p.wordId, p.w.senses || []);
    }

    // 握手池 head：本页页首残段（延续上一页某词），登记后等上一页（neighbor=本页-1）入库时反向合并
    const headwordLoose = (s: string) => String(s || "").toLowerCase().replace(/[?？\s.]/g, "");
    for (const hf of headFragments) {
      await upsertHandshake("head", thisPage - 1, String(hf.headword).trim(), null, hf.senses || []);
    }

    // ---- 场景B核心：本页作为「上一页」，主动合并下一页早已留在池里的 head 残段 ----
    // 例：先录 n 页（页首 X 残段入池，neighbor=n-1），隔很久录 n-1 页，
    // 这里查到 neighbor=n-1 的 head 残段，合并进本页 n-1 的 partial 词 X。
    if (thisPage > 0) {
      const { data: waitHeads } = await supabase.from("vw_page_handshakes")
        .select("id,headword,payload,word_id")
        .eq("book_id", bookId).eq("side", "head")
        .eq("neighbor_page_no", thisPage).eq("status", "pending");
      for (const wh of waitHeads || []) {
        const hwLoose = headwordLoose(wh.headword);
        // 目标词：本页 partial 词条里，词头模糊匹配的那一条；匹配不到则取唯一一条 partial
        const partialProc = processed.filter(p => p.w.partial && !p.isResume);
        let target = hwLoose
          ? partialProc.find(p => headwordLoose(p.hw) === hwLoose)
          : undefined;
        if (!target && partialProc.length === 1) target = partialProc[0];
        if (!target) continue;
        const payloadSenses: Sense[] = Array.isArray(wh.payload) ? wh.payload.map((ps: any) => ({
          sense_no: ps.sense_no ?? 0, pos: ps.pos || "", chinese_def: ps.chinese_def || "",
          items: Array.isArray(ps.items) ? ps.items.map((it: any) => ({
            kind: "sentence", en: it.en || "", zh: it.zh || "",
          })) : [],
        })) : [];
        await mergeIntoSenses(target.wordId, payloadSenses);
        await supabase.from("vw_words").update({ partial: false }).eq("id", target.wordId);
        await supabase.from("vw_page_handshakes")
          .update({ status: "matched", word_id: target.wordId, updated_at: new Date().toISOString() })
          .eq("id", wh.id);
        resumedWords++;
      }
    }

    if (batchId) {
      await supabase.from("vw_scan_batches").update({
        status: "done", words_found: words.length, raw_result: parsed,
        prev_page_no: prevPageNo, partial_words: partialWordsOut,
      }).eq("id", batchId);
    }

    return json({
      ok: true,
      engine_version: "v2.12.0",
      page_no: thisPage,
      detected_page_no: detectedPage,
      header_word: parsed.header_word || null,
      words_found: words.length,
      // 清单对账诊断（v2.12）：验证"图上点名的词是否全部归位"
      reconciliation: {
        check_count: recon.checkCount,
        word_count: recon.wordCount,
        orphan_heads: orphanHeads,
        recovered_heads: recoveredHeads,
        api_calls: attempts,   // 本页实际 AI 调用次数（省流验证用）
      },
      senses_found: senseCount,
      examples_found: exampleCount,
      merged_senses: mergedSenses,
      merged_examples: mergedExamples,
      resumed_words: resumedWords,
      notes_found: noteCount,
      force_cleared: forceCleared,
      handshakes_touched: handshakesTouched,
      derived_words: normalWords.filter((w) => w.derived_from && String(w.derived_from).trim()).map((w) => `${w.headword}<-${w.derived_from}`),
      partial_words: partialWordsOut.map((p: any) => p.headword),
      words: normalWords.map((w) => w.headword),
      boundary: { head: boundary.head || null, tail: boundary.tail || null },
      // 传给下一页：本页页码 + 半截词详情
      nextContext: { page_no: thisPage, partial_words: partialWordsOut },
    });
  } catch (err: any) {
    if (batchId) {
      try { await supabase.from("vw_scan_batches").update({ status: "error", error_msg: String(err.message || err) }).eq("id", batchId); } catch {}
    }
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
});
