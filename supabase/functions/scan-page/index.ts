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

【词头行 → word 字段】
词头行可能以这些"身份符号"开头（务必辨认，圆内细节关键）：
- 无任何符号 = 普通课标词 → 省略 identity_tag
- "*" 星号 = 课标外词 → identity_tag="*"
- ⊕ 黑色实心圆内白色十字（加号）= 2017课标增补词 → identity_tag="⊕"
- ⊖ 黑色实心圆内白色一横（减号）= 2017课标删减词 → identity_tag="⊖"
- 词头带灰底 = 课标词的派生/合成词 → identity_tag="derived"
  注意：⊕ 和 ⊖ 都是黑色实心圆，区别只在圆内是十字(+)还是一横(−)，切勿混淆；也不要把实心圆一律当 ⊖。
- 音标 /…/ 原样存入 phonetic。音标后紧跟"柱状图图标 + R<数字>"，数字存入 freq_level(1..5)。
- 词条行紧跟的中文核心释义存入 level_tag。

【▶/▼ 派生词 → 独立 word】
- 词头行以 ▶ 或 ▼（实心三角）开头的词，如「▶ assuming (that) conj」「▶ attached adj」，是主词的直接派生词：输出为独立 word 对象，derived_from=它所属主词的词头（assuming→assume, attached→attach）。它有自己完整的音标/词性/义项/例句，照常解析，不要并进主词、也不要当例句丢弃。
- 判别：▶/▼ 后若跟一个"新单词词头"（新词+音标/词性）才是派生词；若只是「▼ vi 呼吁」接在名词义项后、后面无新词头，则只是下一个 sense 的词性分节，不派生新词。

【义项 → sense 字段】
- "■ <词性>" 是词性分节符：一词多词性(n./vi./vt./adj./conj./prep./pron.)时，每个 ■ 段落开启一个新的 pos 分组。
- 大号实心黑圆 ①②③ = 义项编号 → sense_no（1/2/3，无则0）。深色序号=高频义 sense_freq=1；浅色序号=低频义 sense_freq=2；看不出则省略。
- 小号空心圆 ①② 或加粗斜体短语 = 义项内固定搭配 → item.kind="phrase"。
- 斜体英文释义（如 to make a serious request for sth）→ sense.english_def。
- 【用法标签】→ usage_label；[C]/[U]/[C]&[U] → countability；「反 X」标签或 原词: → antonym。

【例句 → example 字段】
- kind="sentence"；斜体英文 en + 中文 zh；句末出处（人教③-5 / 2013全国 / 译林新选必①-2）照常存入 source。
- 搭配下的例句放进该 phrase item 的 children。
- 斜体同义注释如 (= die suddenly) → gloss。
- 句型小标题（加粗，如 provide sth for sb）→ item.kind="phrase"，作为该义项下的搭配条。

【蓝底标签框 → notes（重要）】
图中蓝底小方块标签"辨/注/同"开头的方框，不是词条也不是例句，输出到词条的 notes 数组：
- "辨 X, Y"（如 辨 assist, help, aid / 辨 as, which）= 近义词辨析 → note_type="辨", title=主题, content=框内文字。
- "注"（如 否定句中也可用so代替as）= 小贴士 → note_type="注"。
- "同"（如 同 whiskers, moustache）= 词族/近义词 → note_type="同"。
content 保留框内文字与项目符号。不要把这些框里的句子塞进任何单词的例句。

【必须整块跳过：高考链接】
蓝底"高考链接①②③…"方块内是编号试题、_____填空、ABCD选项、试卷出处（如 2020全国Ⅱ卷、2019全国Ⅰ卷(改错)），属高考真题板块，整块不解析：不作词条/义项/例句/notes。注意区分：词条正常例句后的出处（人教③-5、2013全国、译林新选必①-2）是普通例句，照常保留。

【跨页 · partial】
- 页尾词被截断层将在下页继续 → partial=true，boundary.tail 填该词头。
- 页首无完整词头、直接是义项/例句 → 这是延续上一页某词：填 boundary.head；若用户消息含 PREV_PAGE_TAIL，用其中词名作 headword 把延续内容作为该词的 sense 放进 words，以便系统合并；不要把延续内容新建成独立词条或直接丢弃。

【输出精简】字段无值直接省略该键，不要输出空串/空数组/false 占位。无法辨认的字符不要编造，保留原文或留空，务必保留音标与中文。只输出严格 JSON。

输出结构（有值才输出）：
{"page_no":27,"header_word":"appeal","words":[
 {"headword":"apart","partial":false,"phonetic":"/əˈpɑːt/","identity_tag":null,"freq_level":2,"derived_from":null,"level_tag":"相隔的",
  "senses":[{"pos":"adv.","sense_no":1,"sense_freq":1,"countability":"","usage_label":"","chinese_def":"相隔地","english_def":"",
   "items":[{"kind":"phrase","en":"apart from","zh":"除……外","gloss":"","source":"","children":[{"kind":"sentence","en":"...","zh":"...","source":"人教③-5"}]},
            {"kind":"sentence","en":"...","zh":"...","source":"2013全国"}]}],
  "notes":[{"note_type":"辨","title":"apart from, besides","content":"..."}]}
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
};
type Boundary = { head?: { word?: string; note?: string } | null; tail?: { word?: string; note?: string } | null };

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
    out.push({ ...it, parent_phrase: parent || it.en || "" });
    if (it.children?.length) out.push(...flattenItems(it.children, it.en || parent));
  }
  return out;
}

function normEn(s: string): string {
  return (s || "").toLowerCase().replace(/[\s\p{P}]/gu, "");
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

    // 上一页半截词上下文注入提示词
    let userText = "请解析这张词典页面图片，按系统提示的 JSON 结构输出。";
    const prevPartialWords: any[] = Array.isArray(prevContext?.partial_words) ? prevContext.partial_words : [];
    const prevPageNo = prevContext?.page_no ?? null;
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

    const requestAI = async (withJsonMode: boolean) =>
      fetch(`${aiBase}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: aiModel,
          temperature: 0,
          ...(aiBase.includes("ark.cn") ? { thinking: { type: "disabled" } } : {}),
          ...(withJsonMode ? { response_format: { type: "json_object" } } : {}),
          messages,
        }),
      });

    let aiResp = await requestAI(true);
    if (!aiResp.ok) {
      const t = await aiResp.text();
      const unsupported = /response_format|json_object|json mode|unsupported|not support|参数|不支持/i.test(t);
      if (unsupported) aiResp = await requestAI(false);
      else throw new Error(`AI 请求失败 ${aiResp.status}: ${t.slice(0, 300)}`);
    }
    if (!aiResp.ok) {
      const t = await aiResp.text();
      throw new Error(`AI 请求失败 ${aiResp.status}: ${t.slice(0, 300)}`);
    }

    const aiJson = await aiResp.json();
    let content: string = aiJson.choices?.[0]?.message?.content || "";
    content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(content);
    const words: Word[] = Array.isArray(parsed.words) ? parsed.words : [];
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

    // 上一页半截词 headword 集合
    const prevPartialSet = new Set(prevPartialWords.map((p: any) => String(p.headword || "").trim()));

    // 把某词的所有 senses 合并进指定 word_id（义项按 pos|sense_no 合并，例句按文本去重）
    const mergeIntoSenses = async (targetWordId: number, senses: Sense[]) => {
      const { data: existingSenses } = await supabase
        .from("vw_senses").select("id,pos,sense_no,chinese_def").eq("word_id", targetWordId);
      const senseMap = new Map<string, any>();
      for (const es of existingSenses || []) senseMap.set(`${es.pos || ""}|${es.sense_no ?? 0}`, es);

      for (const s of senses || []) {
        const key = `${s.pos || ""}|${s.sense_no ?? 0}`;
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

    // 写入蓝底标签框（辨/注/同/句型）到 vw_notes；先清掉该词旧 notes 再插，避免重扫重复
    let noteCount = 0;
    const writeNotes = async (wordId: number, notes: Note[]) => {
      if (!notes?.length) return;
      await supabase.from("vw_notes").delete().eq("word_id", wordId);
      const rows = notes
        .filter(n => n.note_type && (n.title || n.content))
        .filter(n => !/高考链接|全国卷|新高考|\(改错\)|（改错）/.test(`${n.title || ""}${n.content || ""}`))
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

    // ---- 阶段一：先写入所有"非派生词"，建立 headword -> word_id 映射 ----
    // 派生词(derived_from 非空)留到阶段二，以便回填 parent_word_id。
    const headwordToId = new Map<string, number>();
    const processed: { w: Word; hw: string; wordId: number; isResume: boolean }[] = [];

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

    for (const w of words) {
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

    for (const w of words) {
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

    // 收集本页仍为半截的词（供下一页补全）——含派生词
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
    }

    if (batchId) {
      await supabase.from("vw_scan_batches").update({
        status: "done", words_found: words.length, raw_result: parsed,
        prev_page_no: prevPageNo, partial_words: partialWordsOut,
      }).eq("id", batchId);
    }

    return json({
      ok: true,
      page_no: thisPage,
      detected_page_no: detectedPage,
      header_word: parsed.header_word || null,
      words_found: words.length,
      senses_found: senseCount,
      examples_found: exampleCount,
      merged_senses: mergedSenses,
      merged_examples: mergedExamples,
      resumed_words: resumedWords,
      notes_found: noteCount,
      derived_words: words.filter((w) => w.derived_from && String(w.derived_from).trim()).map((w) => `${w.headword}<-${w.derived_from}`),
      partial_words: partialWordsOut.map((p: any) => p.headword),
      words: words.map((w) => w.headword),
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
