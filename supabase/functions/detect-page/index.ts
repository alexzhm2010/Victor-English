// ============================================================
// Supabase Edge Function: detect-page
// 职责：一张词典页图片 → 多模态 AI 只识别该页印刷页码
// 返回：{ ok, page_no, raw }
// 用于：选图后先逐张识别真实页码 → 按页码排序 → 再逐页扫描入库
// 密钥只在服务端使用，绝不下发前端
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `你是一个页码识别器。给定一张英语词典（如维克多词汇书）的单页照片，你只需要准确读出这一页印刷的页码数字，不要解析单词内容。

输出严格 JSON（不要输出多余文字、不要 markdown 代码块）：
{"page_no": 123}

【识别规则 - 非常重要】
- page_no 是页面上印刷的页码，通常位于页眉或页脚的角落，可能是纯数字，也可能带装饰，如 "- 123 -"、"123"、"第123页"。只取其中的阿拉伯数字。
- 一张图只拍一页。若图中出现多个数字，页码是那个位于页面边缘、字号较小、与书页装订位置对应的印刷数字；不要把词条编号、义项 ①②③、音标数字、例句年份/出处数字、单词数量等误当成页码。
- 若实在无法辨认页码，page_no 设为 0。
- 只输出上面这一个 JSON 对象，不要任何解释。`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
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
      imageUrl, bookId = "victor", batchId: incomingBatch,
      expectedPage = null, imagePath = null,
    } = body;
    if (!imageUrl) return json({ ok: false, error: "缺少 imageUrl" }, 400);
    batchId = incomingBatch ?? null;

    const aiBase  = Deno.env.get("AI_BASE_URL") || "https://ark.cn-beijing.volces.com/api/v3";
    const aiModel = Deno.env.get("AI_MODEL") || "doubao-seed-2-1-lite-260915";
    const apiKey  = Deno.env.get("ARK_API_KEY")
                 || Deno.env.get("OPENAI_API_KEY")
                 || Deno.env.get("VOLC_API_KEY");
    if (!apiKey) return json({ ok: false, error: "服务端未配置 ARK_API_KEY（或 OPENAI_API_KEY）" }, 500);

    let userText = "请只识别这张图片上印刷的页码，按系统提示的 JSON 格式输出。";
    if (expectedPage && expectedPage > 0) {
      // 软提示：仅帮助 AI 在页码模糊时消歧，最终仍以图片实际印刷页码为准
      userText += `\n参考信息：用户计划从第 ${expectedPage} 页附近开始扫描，此信息仅供参考；请以图片中实际印刷的页码为准，不要照搬参考值。`;
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
    let parsed: any = {};
    try { parsed = JSON.parse(content); }
    catch (e) {
      // 兜底：从文本里抠出第一个整数
      const m = content.match(/(\d{1,4})/);
      parsed = { page_no: m ? parseInt(m[1], 10) : 0 };
    }
    const pageNo = Math.max(0, parseInt(parsed.page_no, 10) || 0);

    // 把识别到的真实页码落库到批次记录（页码来源表）
    if (batchId) {
      await supabase.from("vw_scan_batches")
        .update({ page_no: pageNo, status: "detected", raw_result: { detect: parsed } })
        .eq("id", batchId);
    } else if (bookId && imagePath) {
      const { data: ins } = await supabase.from("vw_scan_batches")
        .insert({
          book_id: bookId, image_path: imagePath, image_url: imageUrl,
          page_no: pageNo, status: "detected", raw_result: { detect: parsed },
        })
        .select("id").single();
      if (ins?.id) batchId = ins.id;
    }

    return json({ ok: true, page_no: pageNo, batch_id: batchId, raw: parsed });
  } catch (err: any) {
    if (batchId) {
      try { await supabase.from("vw_scan_batches").update({ status: "error", error_msg: String(err.message || err) }).eq("id", batchId); } catch {}
    }
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
});
